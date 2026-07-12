/**
 * The host engine — all the deterministic orchestration shared by `afk run` (batch) and `afk watch`
 * (daemon). It owns the proven safety nets (serialized git writes, uncommitted-work rescue, stale
 * worktree/container reaping) and the full per-issue → per-feature lifecycle:
 *
 *   implement (Opus, bounded self-correct) → land: a loose issue opens its own PR to the base
 *     branch; a grouped issue merges into its feature branch inside a THROWAWAY worktree
 *     (conflict → Resolver) → when the feature is complete: verify (Sonnet) → classify failure →
 *     Fixer loop / re-run → green ⇒ ready PR + evidence; otherwise escalate with evidence.
 *
 * The host repo's working tree is NEVER mutated: no checkout/merge/reset ever runs in it, so afk
 * can run while the developer is actively editing. Host-side git is limited to fetch, afk-owned
 * branch create/delete, throwaway worktrees, and read-only commands.
 *
 * Side effects are reported two ways: a human `log()` line (console / report) and a structured
 * `emit()` event (the daemon's state store + dashboard). Both are injected, so the engine itself is
 * driver-agnostic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker as dockerSandbox } from "@ai-hero/sandcastle/sandboxes/docker";
import { Resolved } from "./config.js";
import { Feature, Picked, Result, Verdict } from "./types.js";
import { gh, git, isRateLimit, readJson, readText, slug, streamLogging } from "./sh.js";
import { cacheActive, cacheMounts } from "./cache.js";
import { classifyError, classifyVerdict } from "./classify.js";
import { verifyFeature, verdictMarkdown } from "./verify.js";
import { runFixer, runResolver } from "./fix.js";
import type { EventBody } from "./state.js";

const WORKER_IMAGE = "afk-worker";
const RELEASE_TAG = "afk-artifacts";

/** A loose issue (no epic/milestone → routed at the base branch) lands via its OWN PR; a grouped
 *  issue merges into its feature branch. Pure — unit-tested against `deriveFeature`'s outputs. */
export function looseIssue(p: { feature: string; featureKey: string | null }, baseBranch: string): boolean {
  return p.featureKey === null || p.feature === baseBranch;
}

/**
 * Merge `branch` into `target` with `--no-ff` inside a throwaway worktree under
 * `.sandcastle/worktrees/_merge-*` — the host repo's index/working tree are never touched.
 * Never throws — returns the outcome so the caller routes it (conflict → Resolver, failed →
 * escalate) instead of crashing the run.
 *
 * Conflicts are detected via unmerged index entries (`ls-files -u`) in the throwaway worktree —
 * git prints "Automatic merge failed" to STDOUT, which execFileSync's error message doesn't carry,
 * so text classification alone can't see it. A merge that refuses to *start* leaves no MERGE_HEAD —
 * `--abort` would throw, so it stays guarded (crash-loop guard), and the abort runs inside the
 * throwaway worktree before it's removed.
 */
export function mergeInWorktree(
  target: string,
  branch: string,
  message: string,
  opts: { repoDir?: string; log?: (m: string) => void } = {},
): "ok" | "conflict" | "failed" {
  const repo = opts.repoDir ?? ".";
  const G = (args: string[]) => git(["-C", repo, ...args]);
  const wt = path.resolve(repo, ".sandcastle", "worktrees", `_merge-${slug(branch)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    G(["worktree", "add", wt, target]);
  } catch (e) {
    opts.log?.(`couldn't create a merge worktree on ${target}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    return "failed";
  }
  try {
    git(["-C", wt, "merge", "--no-ff", branch, "-m", message]);
    return "ok";
  } catch (e) {
    const conflicted = (() => { try { return git(["-C", wt, "ls-files", "-u"]).trim() !== ""; } catch { return false; } })();
    try { git(["-C", wt, "merge", "--abort"]); } catch { /* nothing to abort — the merge never started */ }
    return conflicted || classifyError(String((e as Error)?.message ?? e)).kind === "conflict" ? "conflict" : "failed";
  } finally {
    try { G(["worktree", "remove", "--force", wt]); } catch { /* leftovers reaped by cleanStartup */ }
  }
}

export type EngineHooks = {
  log?: (msg: string) => void;
  emit?: (e: EventBody) => void;
  /** A live agent-stream line (assistant text / tool call) for the dashboard transcript. */
  activity?: (agentId: string, line: string) => void;
};

export class Engine {
  private gitChain: Promise<unknown> = Promise.resolve();
  private featureBranchReady = new Set<string>();
  private releaseReady = false;
  /** Live features keyed by branch — tracks which issues landed, for the PR + verify trigger. */
  readonly features = new Map<string, Feature>();
  /** Abort controller per running agent id, so the dashboard can stop a single worker. */
  private controllers = new Map<string, AbortController>();
  private stoppedIds = new Set<string>();
  /** Set during daemon shutdown: in-flight agents are aborted but their issues are left re-queueable
   *  (not escalated), so a stop-then-restart resumes them instead of dumping them on a human. */
  private shuttingDown = false;
  /** Number of agents currently registered (running) — lets the daemon wait for a clean drain. */
  get activeAgents(): number { return this.controllers.size; }

  constructor(private cfg: Resolved, private hooks: EngineHooks = {}) {
    for (const d of [cfg.npmCacheDir, cfg.nmCacheDir]) fs.mkdirSync(d, { recursive: true });
  }

  private log(m: string) { (this.hooks.log ?? console.log)(m); }
  private emit(e: EventBody) { this.hooks.emit?.(e); }
  private activity(id: string, line: string) { this.hooks.activity?.(id, line); }

  /** Register an agent's AbortController under its id for the run's lifetime, then clean up. */
  private async withController<T>(agentId: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`${agentId} hit the ${Math.round(timeoutMs / 60000)}m cap`)), timeoutMs);
    this.controllers.set(agentId, ac);
    try { return await fn(ac.signal); }
    finally { clearTimeout(timer); this.controllers.delete(agentId); }
  }

  /** Stop one running agent from the dashboard. Its run aborts; partial work is preserved + escalated. */
  stopAgent(id: string): boolean {
    const ac = this.controllers.get(id);
    if (!ac) return false;
    this.stoppedIds.add(id);
    ac.abort(new Error("Stopped by you from the dashboard."));
    this.log(`  ⏹  ${id}: stopped by user.`);
    return true;
  }

  /** Begin a graceful shutdown: abort every in-flight agent. Their issues are left re-queueable (the
   *  catch checks `shuttingDown`), so the next `afk watch` re-picks them rather than escalating. */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const ac of this.controllers.values()) ac.abort(new Error("daemon shutting down"));
  }

  // ── serialized host-side git writes (parallel workers share ONE host repo) ──
  private withGitLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.gitChain.then(() => fn());
    this.gitChain = next.catch(() => {});
    return next;
  }
  private branchAhead(branch: string, base: string): boolean {
    try { return Number(git(["rev-list", "--count", `${base}..${branch}`]).trim()) > 0; } catch { return false; }
  }

  /** Freshen `origin/<base>` — a plain fetch, so the host tree is untouched. Offline / no remote is
   *  fine: new branches then fork from the local base instead. */
  private fetchBase(): void {
    try { git(["fetch", "origin", this.cfg.baseBranch]); } catch { /* offline / no remote — fall back to local base */ }
  }
  /** The ref new feature/issue branches fork from: `origin/<base>` when it exists (fresh after
   *  `fetchBase`), falling back to the local base (e.g. a fresh repo with no remote ref yet). */
  private baseRef(): string {
    try { git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${this.cfg.baseBranch}`]); return `origin/${this.cfg.baseBranch}`; }
    catch { return this.cfg.baseBranch; }
  }

  private ensureFeatureBranch(fb: string): void {
    if (fb === this.cfg.baseBranch || this.featureBranchReady.has(fb)) return;
    const localExists = git(["branch", "--list", fb]).trim() !== "";
    if (!localExists) {
      const onOrigin = (() => { try { return git(["ls-remote", "--heads", "origin", fb]).trim() !== ""; } catch { return false; } })();
      if (onOrigin) { try { git(["fetch", "origin", `${fb}:${fb}`]); } catch { git(["branch", fb, this.baseRef()]); } }
      else git(["branch", fb, this.baseRef()]);
    }
    this.featureBranchReady.add(fb);
  }

  /** Commit any uncommitted SOURCE changes a worker left behind so real work is never lost. */
  private rescueUncommitted(worktree: string, p: Picked): boolean {
    const G = (args: string[]) => git(["-C", worktree, ...args]);
    const EXCLUDES = [
      ":(exclude,glob).afk/**", ":(exclude,glob).sandcastle/**",
      ":(exclude,glob)**/package-lock.json", ":(exclude,glob)**/pnpm-lock.yaml", ":(exclude,glob)**/node_modules/**",
    ];
    try {
      G(["add", "--", ".", ...EXCLUDES]);
      const staged = G(["diff", "--cached", "--name-only"]).trim();
      if (!staged) return false;
      G(["commit", "--no-verify", "-m",
        `chore: rescue uncommitted work for #${p.number} — ${p.title}\n\n` +
        `The worker finished without committing. The host committed its uncommitted source changes\n` +
        `so they survive for review. NOT verified — review before merging the feature PR.`]);
      this.log(`  🛟 #${p.number}: rescued ${staged.split("\n").length} uncommitted file(s).`);
      return true;
    } catch (e) {
      this.log(`  ⚠️  #${p.number}: rescue commit failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Wipe dirty worktrees (incl. leftover `_merge-*` throwaways) + reap orphaned containers from a
   *  killed prior run. Call once at startup. */
  cleanStartup(): void {
    try {
      for (const m of git(["worktree", "list", "--porcelain"]).matchAll(/^worktree (.*(?:afk-issue-\d+|_merge-).*)$/gim)) {
        try { git(["worktree", "remove", "--force", m[1].trim()]); } catch { /* keep going */ }
      }
      git(["worktree", "prune"]);
    } catch { /* none yet */ }
    try {
      for (const b of git(["branch", "--list", "afk/*"]).split("\n").map((s) => s.replace("*", "").trim()).filter(Boolean)) {
        try { git(["branch", "-D", b]); } catch { /* checked out elsewhere */ }
      }
    } catch { /* none */ }
    try { fs.rmSync(".sandcastle/worktrees", { recursive: true, force: true }); } catch { /* gone */ }
    try {
      const ids = execFileSync("docker", ["ps", "-aq", "--filter", `ancestor=${WORKER_IMAGE}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      for (const id of ids) { try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch { /* keep going */ } }
      if (ids.length) this.log(`Reaped ${ids.length} orphaned worker container(s) from a prior run.`);
    } catch { /* docker down — createSandbox surfaces it */ }
  }

  // ── escalation ──────────────────────────────────────────────────────────────
  escalate(num: number, title: string, reason: string, detail = "", branch?: string): boolean {
    let branchNote = "";
    if (branch) {
      try { git(["push", "-u", "origin", branch]); branchNote = `\n\n🌿 Partial work pushed to branch \`${branch}\`.`; }
      catch { branchNote = `\n\n🌿 Partial work kept on local branch \`${branch}\`.`; }
    }
    gh(["issue", "comment", String(num), "--body", `> *Posted by AFK.*\n\n🛑 **Needs a human.**\n\n${reason}\n${detail}${branchNote}`]);
    try { gh(["issue", "edit", String(num), "--remove-label", this.cfg.labelReady, "--add-label", this.cfg.labelHuman]); } catch { /* labels may not exist */ }
    this.emit({ type: "escalation", issue: num, title, reason, branch });
    return !!branch;
  }

  /** Surface an agent's clarifying question as an issue comment + dashboard card; pause the issue. */
  private ask(p: Picked, q: { question?: string; detail?: string }, branch?: string): boolean {
    let branchNote = "";
    if (branch) {
      try { git(["push", "-u", "origin", branch]); branchNote = `\n\n🌿 Partial work pushed to \`${branch}\` — it resumes when you answer.`; }
      catch { branchNote = `\n\n🌿 Partial work kept on local branch \`${branch}\`.`; }
    }
    gh(["issue", "comment", String(p.number), "--body",
      `> *Posted by AFK.*\n\n❓ **AFK needs input.**\n\n${q.question}\n${q.detail ? `\n${q.detail}` : ""}` +
      `\n\nReply here (or answer on the dashboard) and AFK will resume this issue with your answer in context.${branchNote}`]);
    try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady, "--add-label", this.cfg.labelHuman]); } catch { /* labels */ }
    this.emit({ type: "question", id: `q-${p.number}`, issue: p.number, prompt: q.question ?? "" });
    return !!branch;
  }

  // ── evidence (release assets posted to issue/PR) ──────────────────────────────
  private ensureRelease(): void {
    if (this.releaseReady) return;
    try { gh(["release", "view", RELEASE_TAG]); }
    catch { gh(["release", "create", RELEASE_TAG, "--title", "AFK artifacts", "--notes", "Auto-generated verification evidence.", "--latest=false"]); }
    this.releaseReady = true;
  }
  /** Upload screenshots/GIF found in `dir` and return the markdown to embed + a count. */
  private uploadMedia(label: string, dir: string): { markdown: string; count: number } {
    const assetUrl = (name: string) => `https://github.com/${this.cfg.nwo}/releases/download/${RELEASE_TAG}/${name}`;
    const upload = (srcPath: string, assetName: string): string => {
      const named = path.join(dir, assetName);
      if (path.resolve(srcPath) !== path.resolve(named)) fs.copyFileSync(srcPath, named);
      gh(["release", "upload", RELEASE_TAG, named, "--clobber"]);
      return assetUrl(assetName);
    };
    const gif = path.join(dir, "demo.gif");
    const shotsDir = path.join(dir, "shots");
    const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort() : [];
    if (!fs.existsSync(gif) && shots.length === 0) return { markdown: "", count: 0 };
    this.ensureRelease();
    let md = ""; let count = 0;
    if (fs.existsSync(gif)) { md += `\n\n![demo](${upload(gif, `${label}-demo.gif`)})`; count++; }
    if (shots.length) {
      const imgs = shots.map((s) => `![${s}](${upload(path.join(shotsDir, s), `${label}-${s}`)})`).join("\n\n");
      md += `\n\n<details><summary>Evidence screenshots (${shots.length})</summary>\n\n${imgs}\n\n</details>`;
      count += shots.length;
    }
    return { markdown: md, count };
  }

  // ── per-issue pipeline ────────────────────────────────────────────────────────
  async processIssue(p: Picked): Promise<Result> {
    const issueJson = gh(["issue", "view", String(p.number), "--json", "title,body,comments"]);
    const loose = looseIssue(p, this.cfg.baseBranch);
    // Fresh fork point, no host checkout: fetch origin/<base>, then fork the issue branch from the
    // feature branch (grouped) or straight from origin/<base> (loose).
    const forkRef = await this.withGitLock(() => {
      this.fetchBase();
      this.ensureFeatureBranch(p.feature);
      return loose ? this.baseRef() : p.feature;
    });
    this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "implementing" });
    // Surface the feature node immediately (with its real title) so an in-flight epic child shows up
    // in the tree right away, not only once something merges.
    if (p.featureKey) this.emit({ type: "feature-state", feature: p.featureKey, title: p.featureTitle ?? p.featureKey, state: "building" });
    const agentId = `impl-${p.number}`;
    this.emit({ type: "agent", id: agentId, role: "implement", target: `#${p.number}`, phase: "start" });

    let sandbox: sandcastle.Sandbox | undefined;
    let preserve = false;
    let landed = false;
    const done = (r: Result): Result => { this.emit({ type: "agent", id: agentId, role: "implement", target: `#${p.number}`, phase: "end" }); return r; };
    // The longest, quietest phase: bring up the container + run `setup` (npm install) BEFORE the
    // agent produces any stream output. Tell the dashboard so it isn't a silent "waiting for output".
    this.activity(agentId, `🛠 starting sandbox + running setup (\`${this.cfg.setup}\`)${cacheActive(this.cfg) ? "" : " — dep cache off, so this install is slow"}…`);
    try {
      sandbox = await sandcastle.createSandbox({
        sandbox: dockerSandbox({
          imageName: WORKER_IMAGE,
          mounts: cacheMounts(this.cfg),
        }),
        branch: p.branch,
        baseBranch: forkRef,
        hooks: { sandbox: { onSandboxReady: [{ command: this.cfg.setup, timeoutMs: this.cfg.absoluteTimeoutMs }] } },
      });
      this.activity(agentId, "✅ setup done — launching the agent");

      const afk = path.join(sandbox.worktreePath, ".afk");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`issue #${p.number} hit the ${this.cfg.absoluteTimeoutMin}m absolute cap`)), this.cfg.absoluteTimeoutMs);
      this.controllers.set(agentId, ac); // so the dashboard can stop this worker
      let commits = 0;
      let blocked: any = null;
      try {
        // Bounded self-correction loop (Phase 0): re-run in the SAME sandbox when stuck on own code.
        for (let attempt = 0; attempt <= this.cfg.maxFixAttempts; attempt++) {
          try { fs.rmSync(path.join(afk, "blocked.json"), { force: true }); } catch { /* none yet */ }
          const retryNote = attempt === 0 ? "" :
            `\n\n# RETRY ${attempt}/${this.cfg.maxFixAttempts}\n` +
            `A previous attempt got stuck on its OWN code (not the environment):\n${blocked?.reason ?? ""}\n${blocked?.detail ?? ""}\n` +
            `Your partial work is already in the tree. Take a different approach and commit the moment ` +
            `your own scoped tests pass. If it is genuinely an environment problem, write .afk/blocked.json ` +
            `with "category":"env" and stop.`;
          const r = await sandbox.run({
            name: `impl-#${p.number}${attempt ? `-retry${attempt}` : ""}`,
            agent: sandcastle.claudeCode(this.cfg.models.implement, { env: { CLAUDE_CODE_OAUTH_TOKEN: this.cfg.oauth } }),
            promptFile: ".sandcastle/implement-prompt.md",
            completionSignal: "<promise>COMPLETE</promise>",
            promptArgs: { ISSUE_NUMBER: String(p.number), ISSUE_TITLE: p.title, BRANCH: p.branch, ISSUE_JSON: issueJson, RETRY_NOTE: retryNote },
            idleTimeoutSeconds: this.cfg.idleTimeoutSec,
            signal: ac.signal,
            logging: streamLogging(path.join(".afk", "logs", `${agentId}${attempt ? `-r${attempt}` : ""}.log`), (line) => this.activity(agentId, line)),
          });
          commits = r.commits.length;
          blocked = readJson(path.join(afk, "blocked.json"));
          const envBlocked = !!blocked && String(blocked.category ?? "").toLowerCase() === "env";
          const stuckOnOwnCode = !!blocked && !envBlocked;
          const producedNothing = commits === 0 && !blocked;
          if (!stuckOnOwnCode && !producedNothing) break;
          if (attempt >= this.cfg.maxFixAttempts) break;
          this.log(`  ↻ #${p.number}: self-correction retry ${attempt + 1}/${this.cfg.maxFixAttempts} (${stuckOnOwnCode ? "stuck on own code" : "no commits"}).`);
        }
      } catch (e) {
        if (isRateLimit(e)) throw e;
        // Graceful daemon shutdown: don't rescue/escalate — just leave the issue ready so the next
        // run re-picks it. (The label was never removed, so it's still in the queue.)
        if (this.shuttingDown) {
          this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "queued", note: "daemon stopped mid-run — will resume on next start" });
          return done({ num: p.number, title: p.title, status: "stopped", feature: p.feature });
        }
        if (sandbox && !this.branchAhead(p.branch, forkRef)) this.rescueUncommitted(sandbox.worktreePath, p);
        const userStopped = this.stoppedIds.has(agentId);
        const reason = userStopped
          ? "Stopped by you from the dashboard — partial work preserved."
          : ac.signal.aborted
          ? `Worker hit the ${this.cfg.absoluteTimeoutMin}m absolute cap.`
          : `Worker stalled (idle > ${this.cfg.idleTimeoutSec / 60}m) or errored before finishing.`;
        const wb = this.branchAhead(p.branch, forkRef) ? p.branch : undefined;
        preserve = this.escalate(p.number, p.title, reason, userStopped ? "" : `\n\`\`\`\n${String((e as Error)?.message ?? e).slice(0, 800)}\n\`\`\``, wb);
        const status: "stopped" | "timeout" | "error" = userStopped ? "stopped" : ac.signal.aborted ? "timeout" : "error";
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: status });
        return done({ num: p.number, title: p.title, status, feature: p.feature });
      } finally { clearTimeout(timer); this.controllers.delete(agentId); }

      const summary = readText(path.join(afk, "summary.md")) ?? "_(worker wrote no summary)_";
      const question = readJson(path.join(afk, "question.json")) as { question?: string; detail?: string } | null;
      const rescued = commits === 0 && !question && this.rescueUncommitted(sandbox.worktreePath, p);
      if (rescued) commits = 1;
      const workBranch = commits > 0 ? p.branch : undefined;

      // A clarifying question takes priority: the agent hit a genuine decision it shouldn't guess.
      // Post it (issue comment + dashboard card) and pause this issue until a human answers — the
      // answer lands as a comment, so the next run sees it in context. This is the pressure-release
      // valve so agents ask instead of guessing or escalating wholesale.
      if (question?.question) {
        preserve = this.ask(p, question, workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "question" });
        return done({ num: p.number, title: p.title, status: "question", feature: p.feature });
      }

      if (commits === 0 && !blocked) {
        this.escalate(p.number, p.title, "The worker produced no commits and left no uncommitted work to recover.");
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
        return done({ num: p.number, title: p.title, status: "no-commits", feature: p.feature });
      }
      if (blocked) {
        preserve = this.escalate(p.number, p.title, `The worker bailed: ${blocked.reason ?? "blocked"}.`, blocked.detail ? `\n${blocked.detail}` : "", workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "blocked" });
        return done({ num: p.number, title: p.title, status: "blocked", feature: p.feature });
      }
      if (rescued) {
        preserve = this.escalate(p.number, p.title, "Worker finished without committing — host recovered its uncommitted work.",
          "The recovered changes are **not** verified — review the feature branch before merging.", workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "rescued" });
        return done({ num: p.number, title: p.title, status: "rescued", feature: p.feature });
      }

      // ── land: loose issue → its own PR to the base branch (no local merge, ever) ──
      if (loose) {
        const url = this.openIssuePR(p, summary);
        if (!url) {
          preserve = this.escalate(p.number, p.title, `Implemented \`${p.branch}\` but couldn't push it / open its PR against \`${this.cfg.baseBranch}\`.`, "", workBranch);
          this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "error" });
          return done({ num: p.number, title: p.title, status: "error", feature: p.feature });
        }
        landed = true;
        // The PR body's `Closes #N` closes the issue when it merges — don't close it here.
        gh(["issue", "comment", String(p.number), "--body", `> *Posted by AFK.*\n\n✅ **Done — PR opened: ${url}**\n\n${summary}`]);
        try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady]); } catch { /* label may not exist */ }
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "merged" });
        return done({ num: p.number, title: p.title, status: "merged", feature: p.feature });
      }

      // ── grouped: merge issue branch → feature branch in a throwaway worktree; conflict → Resolver ──
      const merge = await this.tryMerge(p);
      let failReason: string | null = null;
      if (merge === "conflict") {
        this.log(`  ⚔️  #${p.number}: merge conflict — routing to Resolver.`);
        if (!(await this.tryResolve(p, issueJson)))
          failReason = `Merge conflict with \`${p.feature}\` the Resolver couldn't reconcile. Needs a human.`;
      } else if (merge === "failed") {
        failReason = `Couldn't merge \`${p.branch}\` into \`${p.feature}\` — the throwaway merge worktree couldn't be created (is \`${p.feature}\` checked out somewhere?) or the merge failed before starting. Partial work is preserved; re-queue after checking the branch.`;
      }
      if (failReason) {
        const st = merge === "conflict" ? "conflict" : "error";
        preserve = this.escalate(p.number, p.title, failReason, "", workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: st });
        return done({ num: p.number, title: p.title, status: st, feature: p.feature });
      }
      landed = true;

      // track for the feature PR + verify trigger; comment + close the issue
      if (p.featureKey) {
        const f = this.features.get(p.feature) ?? { key: p.featureKey, title: p.featureTitle ?? p.featureKey, branch: p.feature, merged: [] };
        f.merged.push(p.number); this.features.set(p.feature, f);
      }
      gh(["issue", "comment", String(p.number), "--body", `> *Posted by AFK.*\n\n✅ **Done — landed on \`${p.feature}\` (feature branch).**\n\n${summary}`]);
      try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady]); } catch { /* label may not exist */ }
      gh(["issue", "close", String(p.number)]);
      this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "merged" });
      return done({ num: p.number, title: p.title, status: "merged", feature: p.feature });
    } finally {
      const wt = sandbox?.worktreePath;
      if (sandbox) await sandbox.close().catch(() => {});
      if (landed || !preserve) await this.withGitLock(() => {
        if (wt) { try { git(["worktree", "remove", "--force", wt]); } catch { /* already gone */ } }
        try { git(["branch", "-D", p.branch]); } catch { /* gone / checked out */ }
      });
    }
  }

  /** Push a loose issue's branch and open (or refresh) its own PR against the base branch. The PR
   *  body carries `Closes #N`, so the issue closes when the PR merges. Returns the PR url or null. */
  private openIssuePR(p: Picked, summary: string): string | null {
    try { git(["push", "-u", "origin", p.branch]); }
    catch (e) {
      this.log(`  ⚠️  #${p.number}: couldn't push ${p.branch}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      return null;
    }
    const body = `> *Opened by AFK.*\n\nCloses #${p.number}\n\n${summary}`;
    try {
      return gh(["pr", "create", "--base", this.cfg.baseBranch, "--head", p.branch, "--title", `feat: ${p.title} (#${p.number})`, "--body", body]).trim();
    } catch {
      // A PR for this branch may already exist (re-run) — refresh its body and return its url.
      try { gh(["pr", "edit", p.branch, "--body", body]); } catch { /* ignore */ }
      try { return gh(["pr", "view", p.branch, "--json", "url", "-q", ".url"]).trim(); } catch { return null; }
    }
  }

  /** Merge the issue branch into its feature branch inside a throwaway worktree (the host tree is
   *  never touched). Never throws — returns the outcome so the caller routes it (conflict →
   *  Resolver, failed → escalate) instead of crashing the run. */
  private tryMerge(p: Picked): Promise<"ok" | "conflict" | "failed"> {
    return this.withGitLock(() =>
      mergeInWorktree(p.feature, p.branch, `feat: ${p.title} (#${p.number})`, { log: (m) => this.log(`  ⚠️  #${p.number}: ${m}`) }),
    );
  }

  /** Run the Resolver on the feature branch (in its own sandboxed worktree — no host checkout).
   *  Returns true if the merge now completed cleanly. */
  private async tryResolve(p: Picked, issueJson: string): Promise<boolean> {
    const id = `resolve-${p.number}`;
    this.emit({ type: "agent", id, role: "resolve", target: `#${p.number}`, phase: "start" });
    try {
      const out = await this.withController(id, this.cfg.absoluteTimeoutMs, (signal) =>
        runResolver(this.cfg, p.feature, p.branch, issueJson, { signal, onActivity: (l) => this.activity(id, l) }),
      );
      // Resolved iff the resolver committed the merge and didn't bail.
      return out.commits > 0 && !out.blocked && this.branchAhead(p.feature, this.baseRef());
    } catch (e) {
      this.log(`  ⚠️  Resolver failed for #${p.number}: ${(e as Error)?.message ?? e}`);
      return false;
    } finally {
      this.emit({ type: "agent", id, role: "resolve", target: `#${p.number}`, phase: "end" });
    }
  }

  // ── feature completion: verify → fix loop → PR ───────────────────────────────
  /**
   * The feature's children as GitHub sees them right now, partitioned by state. Authoritative — so
   * verify covers EVERY criterion and the PR closes EVERY child, even ones that landed in an earlier
   * `afk run` (when the in-memory `feature.merged` only holds this run's issues).
   */
  private featureChildren(feature: Feature): { openReady: number[]; landed: number[] } {
    try {
      let all: { number: number; state: string; body?: string; labels?: { name: string }[] }[];
      if (feature.key.startsWith("ms-")) {
        all = JSON.parse(gh(["issue", "list", "--milestone", feature.title, "--state", "all", "--json", "number,state,labels", "--limit", "200"]));
      } else {
        const epicNum = feature.key.replace("epic-", "");
        const re = new RegExp(`/issues/${epicNum}\\b|#${epicNum}\\b`);
        all = (JSON.parse(gh(["issue", "list", "--state", "all", "--json", "number,state,body,labels", "--limit", "200"])) as typeof all)
          .filter((i) => /##\s*Parent/i.test(i.body ?? "") && re.test(i.body ?? ""));
      }
      const hasReady = (i: { labels?: { name: string }[] }) => (i.labels ?? []).some((l) => l.name === this.cfg.labelReady);
      const openReady = all.filter((i) => i.state === "OPEN" && hasReady(i)).map((i) => i.number);
      const landed = all.filter((i) => i.state === "CLOSED").map((i) => i.number);
      return { openReady, landed };
    } catch { return { openReady: [], landed: [] }; }
  }

  /** Authoritative landed-children set: this run's merges ∪ GitHub's closed children, deduped. */
  private landedChildren(feature: Feature): number[] {
    return [...new Set([...feature.merged, ...this.featureChildren(feature).landed])].sort((a, b) => a - b);
  }

  /** True when every child of the feature has landed (no ready ones left) and ≥1 has merged. */
  isFeatureComplete(feature: Feature): boolean {
    const { openReady, landed } = this.featureChildren(feature);
    return openReady.length === 0 && (feature.merged.length > 0 || landed.length > 0);
  }

  /** Build the JSON of the feature's landed issues — their bodies carry the acceptance criteria. */
  private featureIssuesJson(feature: Feature): string {
    const issues = this.landedChildren(feature).map((n) => {
      try { return JSON.parse(gh(["issue", "view", String(n), "--json", "number,title,body"])); } catch { return { number: n }; }
    });
    return JSON.stringify(issues, null, 2);
  }

  /**
   * Verify a completed feature, run the bounded Fixer loop on failure, and open/promote its PR.
   * Returns the final verdict (or null when unverified/escalated). Safe to call once per feature.
   */
  async finalizeFeature(feature: Feature): Promise<void> {
    if (feature.branch === this.cfg.baseBranch) return; // legacy: no PR for base-branch merges
    const issuesJson = this.featureIssuesJson(feature);
    this.emit({ type: "feature-state", feature: feature.key, title: feature.title, state: "verifying" });
    this.log(`\n🔎 Verifying feature ${feature.title} (${feature.branch})…`);

    let verdict: Verdict | null = null;
    let unverifiedReason: string | null = null;
    let evidenceMd = "";

    const verifyId = `verify-${feature.key}`;
    // verify → (flaky? one re-run) → (logic? fix loop) → settle
    for (let fixAttempt = 0; fixAttempt <= this.cfg.maxFixAttempts; fixAttempt++) {
      this.emit({ type: "agent", id: verifyId, role: "verify", target: feature.title, phase: "start" });
      const vr = await this.withController(verifyId, (this.cfg.verify.timeoutSec ?? 1200) * 1000, (signal) =>
        verifyFeature(this.cfg, feature, issuesJson, { signal, onActivity: (l) => this.activity(verifyId, l) }),
      ).catch((e) => {
        if (isRateLimit(e)) throw e;
        return { kind: "unverified", reason: `Verifier ${this.stoppedIds.has(verifyId) ? "stopped by you" : "errored"}: ${(e as Error)?.message ?? e}` } as const;
      });
      this.emit({ type: "agent", id: verifyId, role: "verify", target: feature.title, phase: "end" });

      if (vr.kind === "unverified") { unverifiedReason = vr.reason; break; }
      verdict = vr.verdict;
      const ev = this.uploadMedia(`verify-${slug(feature.title)}`, vr.evidenceDir);
      evidenceMd = ev.markdown;
      this.emit({ type: "verdict", feature: feature.key, ok: verdict.ok, summary: verdict.summary, passed: verdict.criteria.filter((c) => c.pass).length, total: verdict.criteria.length });

      if (verdict.ok) break;
      const cls = classifyVerdict(verdict);
      this.log(`  ❌ verify failed → ${cls.kind}: ${cls.reason}`);
      if (cls.kind === "env" || cls.kind === "ambiguous") break; // escalate, don't loop
      if (fixAttempt >= this.cfg.maxFixAttempts) break;          // out of attempts
      if (cls.kind === "flaky") { this.log(`  ↻ flaky — one automatic re-verify.`); continue; }
      // logic → Fixer
      const fixId = `fix-${feature.key}-${fixAttempt}`;
      this.emit({ type: "feature-state", feature: feature.key, title: feature.title, state: "fixing" });
      this.emit({ type: "agent", id: fixId, role: "fix", target: feature.title, phase: "start" });
      const fx = await this.withController(fixId, this.cfg.absoluteTimeoutMs, (signal) =>
        runFixer(this.cfg, feature, verdict!, fixAttempt + 1, this.cfg.maxFixAttempts, { signal, onActivity: (l) => this.activity(fixId, l) }),
      ).catch((e) => { if (isRateLimit(e)) throw e; this.log(`  ⚠️  Fixer ${this.stoppedIds.has(fixId) ? "stopped" : "errored"}: ${(e as Error)?.message ?? e}`); return { commits: 0, blocked: { reason: "fixer stopped/errored" }, worktreePath: undefined }; });
      this.emit({ type: "agent", id: fixId, role: "fix", target: feature.title, phase: "end" });
      if (fx.blocked) { this.log(`  🛟 Fixer bailed: ${fx.blocked.reason ?? "blocked"}.`); break; }
      // loop re-verifies
    }

    await this.openFeaturePR(feature, { verdict, unverifiedReason, evidenceMd });
  }

  /** Open (or refresh) the single PR for a feature. Ready iff verified green or honestly unverified. */
  async openFeaturePR(feature: Feature, v: { verdict: Verdict | null; unverifiedReason: string | null; evidenceMd: string }): Promise<string | null> {
    if (feature.branch === this.cfg.baseBranch || feature.merged.length === 0) return null;
    // Push by refspec — no host checkout is ever needed to publish the feature branch.
    try { git(["push", "origin", feature.branch]); } catch { /* may be up to date */ }

    const incomplete = this.featureChildren(feature).openReady.length > 0;
    const closes = this.landedChildren(feature).map((n) => `Closes #${n}`).join("\n");

    let status: string; let state: "draft" | "ready";
    if (incomplete) { status = `⏳ Feature not complete yet — draft until all child issues land.`; state = "draft"; }
    else if (v.verdict?.ok) { status = `${verdictMarkdown(v.verdict)}${v.evidenceMd}`; state = "ready"; }
    else if (v.verdict && !v.verdict.ok) { status = `${verdictMarkdown(v.verdict)}${v.evidenceMd}\n\n🛑 Verification failed and the Fixer couldn't make it green — needs a human.`; state = "draft"; }
    else { status = `⚠️ **Unverified** — ${v.unverifiedReason}. Tests pass per the implementers, but AFK couldn't run an end-to-end check on this host. Please test manually before merging.`; state = "ready"; }

    const body = `> *Opened by AFK.*\n\nImplements **${feature.title}**.\n\n${closes}\n\n${status}`;
    const url = this.createOrUpdatePR(feature.branch, feature.title, body, state === "draft");
    if (url) this.emit({ type: "pr", feature: feature.key, url, state });
    // One feature-state: building (incomplete) · verified (green) · needs-human (verify failed) · unverified.
    const fState = incomplete ? "building" : v.verdict?.ok ? "verified" : v.verdict ? "needs-human" : "unverified";
    this.emit({ type: "feature-state", feature: feature.key, title: feature.title, state: fState });
    return url;
  }

  private createOrUpdatePR(branch: string, title: string, body: string, draft: boolean): string | null {
    try {
      return gh(["pr", "create", "--base", this.cfg.baseBranch, "--head", branch, "--title", `feat: ${title}`, "--body", body, ...(draft ? ["--draft"] : [])]).trim();
    } catch {
      try { gh(["pr", "edit", branch, "--body", body]); } catch { /* ignore */ }
      if (!draft) { try { gh(["pr", "ready", branch]); } catch { /* already ready */ } }
      try { return gh(["pr", "view", branch, "--json", "url", "-q", ".url"]).trim(); } catch { return null; }
    }
  }
}
