/**
 * The host engine — all the deterministic orchestration shared by `afk run` (batch) and `afk watch`
 * (daemon). It owns the proven safety nets (serialized git writes, uncommitted-work rescue, stale
 * worktree/container reaping) and the full per-issue → per-feature lifecycle:
 *
 *   implement (Opus, bounded self-correct) → review (best-effort, same sandbox; severe finding ⇒
 *     escalate) → land: a loose issue opens its own PR to the base
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
/** PR label marking "green, but a human live-verification pass is still owed" (see `liveVerify`). */
export const LIVE_VERIFY_LABEL = "verify:live-pending";

/** A loose issue (no epic/milestone → routed at the base branch) lands via its OWN PR; a grouped
 *  issue merges into its feature branch. Pure — unit-tested against `deriveFeature`'s outputs. */
export function looseIssue(p: { feature: string; featureKey: string | null }, baseBranch: string): boolean {
  return p.featureKey === null || p.feature === baseBranch;
}

/** Route the Reviewer's outcome. Pure — unit-tested. Review is best-effort: only a rate limit
 *  (must bubble up so run/watch back off, like every other agent path) or an explicit severe
 *  finding in `.afk/review.json` stops a good implement from landing. */
export function routeReview(err: unknown, review: unknown):
  | { action: "rethrow" }
  | { action: "escalate"; reason: string }
  | { action: "proceed"; warn?: string } {
  // Precedence: rate limit (must bubble up) → severe finding (a reviewer that wrote a severe
  // review.json and THEN errored still blocks the landing) → other error → clean proceed.
  if (err != null && isRateLimit(err)) return { action: "rethrow" };
  const severe = (review as { severe?: unknown } | null)?.severe;
  if (typeof severe === "string" && severe.trim() !== "") return { action: "escalate", reason: severe };
  if (err != null) return { action: "proceed", warn: String((err as Error)?.message ?? err).split("\n")[0] };
  return { action: "proceed" };
}

/** Route a finished research run's signal files. Pure — unit-tested. Priority mirrors the
 *  implement lane: a clarifying question pauses the issue; a bail escalates with the agent's
 *  reason; otherwise non-empty findings publish (comment + close) and missing/empty findings
 *  escalate — never a silent "done" with nothing to show. */
export function routeResearch(
  question: { question?: string; detail?: string } | null,
  blocked: { reason?: string; detail?: string } | null,
  findings: string | null,
):
  | { action: "question"; q: { question?: string; detail?: string } }
  | { action: "escalate"; reason: string; detail: string }
  | { action: "publish"; findings: string } {
  if (question?.question) return { action: "question", q: question };
  if (blocked) return { action: "escalate", reason: `The researcher bailed: ${blocked.reason ?? "blocked"}.`, detail: blocked.detail ? `\n${blocked.detail}` : "" };
  if (findings !== null && findings.trim() !== "") return { action: "publish", findings };
  return { action: "escalate", reason: "The researcher produced no findings file (`.afk/research.md` missing or empty).", detail: "" };
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

/** Union two child-issue lists, deduped by issue number (first list wins on overlap). Pure —
 *  unit-tested. `featureChildren` uses it to merge body-text `## Parent` matches with the epic's
 *  NATIVE sub-issues, which the planner now groups by (body text alone misses them). */
export function unionChildren<T extends { number: number }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((i) => i.number));
  return [...a, ...b.filter((i) => !seen.has(i.number))];
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

  /** Bases already fetched this round — a round may span multiple bases; each DISTINCT base is
   *  fetched once per round, not once per issue. Cleared by `beginRound()`. */
  private fetchedBases = new Set<string>();
  /** Reset the per-round base-fetch dedupe. Drivers call this at the start of each planning round. */
  beginRound(): void { this.fetchedBases.clear(); }

  /** Freshen `origin/<base>` — a plain fetch, so the host tree is untouched. Deduped per round.
   *  Offline / no remote is fine: the config default then forks from the local base instead. */
  private fetchBase(base: string): void {
    if (this.fetchedBases.has(base)) return;
    this.fetchedBases.add(base);
    try { git(["fetch", "origin", base]); } catch { /* offline / no remote — fall back to local base */ }
  }
  /** The ref new feature/issue branches fork from: `origin/<base>` when it exists (fresh after
   *  `fetchBase`). When it doesn't, only the CONFIG default may fall back to the local branch (the
   *  fresh-repo case); an explicitly declared base gets NO fallback — null means the base is
   *  invalid (typo'd `Base:` line) and the caller must escalate instead of running the issue. */
  private baseRef(base: string): string | null {
    try { git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]); return `origin/${base}`; }
    catch { return base === this.cfg.baseBranch ? base : null; }
  }

  private ensureFeatureBranch(fb: string, base: string, forkRef: string): void {
    if (fb === base || this.featureBranchReady.has(fb)) return;
    const localExists = git(["branch", "--list", fb]).trim() !== "";
    if (!localExists) {
      const onOrigin = (() => { try { return git(["ls-remote", "--heads", "origin", fb]).trim() !== ""; } catch { return false; } })();
      if (onOrigin) { try { git(["fetch", "origin", `${fb}:${fb}`]); } catch { git(["branch", fb, forkRef]); } }
      else git(["branch", fb, forkRef]);
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

  /** Demote an ineligible `ready-for-agent` issue (parent/epic or HITL — see planner
   *  `ineligibleReason`) to the human queue: one comment naming the failed criterion + label swap.
   *  Lives here with `escalate` because it's a GitHub mutation — the planner only decides. */
  demote(num: number, title: string, reason: string): void {
    // Label swap FIRST: if it fails (e.g. the human label doesn't exist in this repo) the issue
    // stays `ready` and gets re-demoted every poll — so post no comment (spam), just warn.
    try { gh(["issue", "edit", String(num), "--remove-label", this.cfg.labelReady, "--add-label", this.cfg.labelHuman]); }
    catch (e) {
      this.log(`  ⚠️  #${num}: demote label swap failed — does the \`${this.cfg.labelHuman}\` label exist in ${this.cfg.nwo}? (${String((e as Error)?.message ?? e).split("\n")[0]})`);
      return;
    }
    gh(["issue", "comment", String(num), "--body", `> *Posted by AFK.*\n\n${reason}`]);
    this.emit({ type: "escalation", issue: num, title, reason });
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
    if (p.mode === "research") return this.researchIssue(p);
    const issueJson = gh(["issue", "view", String(p.number), "--json", "title,body,comments"]);
    const loose = looseIssue(p, p.base);
    // Fresh fork point, no host checkout: fetch origin/<base> (the ISSUE's base), then fork the
    // issue branch from the feature branch (grouped) or straight from origin/<base> (loose).
    const forkRef = await this.withGitLock((): string | null => {
      this.fetchBase(p.base);
      const ref = this.baseRef(p.base);
      if (ref === null) return null; // declared base doesn't exist on origin — escalate below
      this.ensureFeatureBranch(p.feature, p.base, ref);
      return loose ? ref : p.feature;
    });
    if (forkRef === null) {
      // A typo'd `Base:` line — running would fork and PR against the WRONG (nonexistent) branch.
      this.escalate(p.number, p.title,
        `The declared base branch \`${p.base}\` doesn't exist on origin (declared via ${p.baseSource}).`,
        "\nFix the branch name (or push the branch), then re-queue the issue.");
      this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
      return { num: p.number, title: p.title, status: "error", feature: p.feature, base: p.base };
    }
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
          // Clear stale signal files — sandcastle can reuse a preserved dirty worktree, and a stale
          // question.json would re-pause the issue / a stale summary.md would land in comments/PRs.
          for (const f of ["blocked.json", "question.json", "summary.md"]) { try { fs.rmSync(path.join(afk, f), { force: true }); } catch { /* none yet */ } }
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
          return done({ num: p.number, title: p.title, status: "stopped", feature: p.feature, base: p.base });
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
        return done({ num: p.number, title: p.title, status, feature: p.feature, base: p.base });
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
        return done({ num: p.number, title: p.title, status: "question", feature: p.feature, base: p.base });
      }

      if (commits === 0 && !blocked) {
        this.escalate(p.number, p.title, "The worker produced no commits and left no uncommitted work to recover.");
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
        return done({ num: p.number, title: p.title, status: "no-commits", feature: p.feature, base: p.base });
      }
      if (blocked) {
        preserve = this.escalate(p.number, p.title, `The worker bailed: ${blocked.reason ?? "blocked"}.`, blocked.detail ? `\n${blocked.detail}` : "", workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "blocked" });
        return done({ num: p.number, title: p.title, status: "blocked", feature: p.feature, base: p.base });
      }
      if (rescued) {
        preserve = this.escalate(p.number, p.title, "Worker finished without committing — host recovered its uncommitted work.",
          "The recovered changes are **not** verified — review the feature branch before merging.", workBranch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "rescued" });
        return done({ num: p.number, title: p.title, status: "rescued", feature: p.feature, base: p.base });
      }

      // ── review: best-effort second pair of eyes in the SAME warm sandbox, before any landing ──
      // The Reviewer may commit small fixes on the issue branch (they land with the rest). Only an
      // explicit severe finding blocks the landing; any other review failure just logs and proceeds.
      const severe = await this.reviewIssue(sandbox, p, issueJson, forkRef);
      if (severe) {
        preserve = this.escalate(p.number, p.title, `The Reviewer flagged a severe problem it couldn't safely fix: ${severe}`, "", p.branch);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
        return done({ num: p.number, title: p.title, status: "blocked", feature: p.feature, base: p.base });
      }

      // ── land: loose issue → its own PR to the base branch (no local merge, ever) ──
      if (loose) {
        const url = this.openIssuePR(p, summary);
        if (!url) {
          preserve = this.escalate(p.number, p.title, `Implemented \`${p.branch}\` but couldn't push it / open its PR against \`${p.base}\`.`, "", workBranch);
          this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "error" });
          return done({ num: p.number, title: p.title, status: "error", feature: p.feature, base: p.base });
        }
        landed = true;
        // The PR body's `Closes #N` closes the issue when it merges — don't close it here.
        const liveNote = p.liveVerify ? `\n\n🔬 The PR is a **draft** pending a live verification pass (\`Verify (live)\` requested in the issue).` : "";
        gh(["issue", "comment", String(p.number), "--body", `> *Posted by AFK.*\n\n✅ **Done — PR opened: ${url}**${liveNote}\n\n${summary}`]);
        try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady]); } catch { /* label may not exist */ }
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "merged" });
        return done({ num: p.number, title: p.title, status: "merged", feature: p.feature, base: p.base });
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
        return done({ num: p.number, title: p.title, status: st, feature: p.feature, base: p.base });
      }
      landed = true;

      // track for the feature PR + verify trigger; comment + close the issue
      if (p.featureKey) {
        const f = this.features.get(p.feature) ?? { key: p.featureKey, title: p.featureTitle ?? p.featureKey, branch: p.feature, base: p.base, merged: [], liveVerify: [] };
        f.merged.push(p.number);
        if (p.liveVerify) f.liveVerify.push(p.number);
        this.features.set(p.feature, f);
      }
      const groupedLiveNote = p.liveVerify ? `\n\n🔬 The feature PR will stay a **draft** pending a live verification pass (\`Verify (live)\` requested in this issue).` : "";
      gh(["issue", "comment", String(p.number), "--body", `> *Posted by AFK.*\n\n✅ **Done — landed on \`${p.feature}\` (feature branch).**${groupedLiveNote}\n\n${summary}`]);
      try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady]); } catch { /* label may not exist */ }
      gh(["issue", "close", String(p.number)]);
      this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "merged" });
      return done({ num: p.number, title: p.title, status: "merged", feature: p.feature, base: p.base });
    } finally {
      const wt = sandbox?.worktreePath;
      if (sandbox) await sandbox.close().catch(() => {});
      if (landed || !preserve) await this.withGitLock(() => {
        if (wt) { try { git(["worktree", "remove", "--force", wt]); } catch { /* already gone */ } }
        try { git(["branch", "-D", p.branch]); } catch { /* gone / checked out */ }
      });
    }
  }

  // ── research lane (`Picked.mode === "research"`) ─────────────────────────────
  /**
   * A `wayfinder:research` ticket: same sandbox creation on the issue branch (harmless — research
   * makes no commits), same setup hook and abort/rate-limit discipline as implement, but the
   * deliverable is `.afk/research.md` — posted as the resolution comment (clearly AFK-authored,
   * unreviewed) and the issue is CLOSED (auto-close is the chosen policy — routing.md,
   * "`wayfinder:research` tickets"). NO review pass, NO rescue, NO merge, NO push, NO PR: any
   * commits the agent makes despite instructions are simply discarded with the branch.
   */
  private async researchIssue(p: Picked): Promise<Result> {
    const issueJson = gh(["issue", "view", String(p.number), "--json", "title,body,comments"]);
    const result = (status: Result["status"]): Result => ({ num: p.number, title: p.title, status, feature: p.feature, base: p.base });
    // Same fresh fork point as implement — no feature branch though: research never lands code.
    const forkRef = await this.withGitLock((): string | null => {
      this.fetchBase(p.base);
      return this.baseRef(p.base);
    });
    if (forkRef === null) {
      this.escalate(p.number, p.title,
        `The declared base branch \`${p.base}\` doesn't exist on origin (declared via ${p.baseSource}).`,
        "\nFix the branch name (or push the branch), then re-queue the issue.");
      this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
      return result("error");
    }
    this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "implementing", note: "research" });
    const agentId = `research-${p.number}`;
    this.emit({ type: "agent", id: agentId, role: "research", target: `#${p.number}`, phase: "start" });
    const done = (r: Result): Result => { this.emit({ type: "agent", id: agentId, role: "research", target: `#${p.number}`, phase: "end" }); return r; };

    let sandbox: sandcastle.Sandbox | undefined;
    this.activity(agentId, `🛠 starting sandbox + running setup (\`${this.cfg.setup}\`)${cacheActive(this.cfg) ? "" : " — dep cache off, so this install is slow"}…`);
    try {
      sandbox = await sandcastle.createSandbox({
        sandbox: dockerSandbox({ imageName: WORKER_IMAGE, mounts: cacheMounts(this.cfg) }),
        branch: p.branch,
        baseBranch: forkRef,
        hooks: { sandbox: { onSandboxReady: [{ command: this.cfg.setup, timeoutMs: this.cfg.absoluteTimeoutMs }] } },
      });
      if (!fs.existsSync(path.join(sandbox.worktreePath, ".sandcastle", "research-prompt.md"))) {
        this.demote(p.number, p.title,
          `🔍 Routed to a human: this is a \`wayfinder:research\` ticket, but research mode isn't scaffolded in this repo — no \`.sandcastle/research-prompt.md\` on the branch. Re-run \`afk init\` to scaffold it, then re-queue the issue.`);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "escalated" });
        return done(result("blocked"));
      }
      this.activity(agentId, "✅ setup done — launching the researcher");

      const afk = path.join(sandbox.worktreePath, ".afk");
      for (const f of ["blocked.json", "question.json", "research.md"]) { try { fs.rmSync(path.join(afk, f), { force: true }); } catch { /* none yet */ } }
      try {
        await this.withController(agentId, this.cfg.absoluteTimeoutMs, (signal) =>
          sandbox!.run({
            name: `research-#${p.number}`,
            agent: sandcastle.claudeCode(this.cfg.models.research, { env: { CLAUDE_CODE_OAUTH_TOKEN: this.cfg.oauth } }),
            promptFile: ".sandcastle/research-prompt.md",
            completionSignal: "<promise>COMPLETE</promise>",
            maxIterations: 1,
            promptArgs: { ISSUE_NUMBER: String(p.number), ISSUE_TITLE: p.title, ISSUE_JSON: issueJson },
            idleTimeoutSeconds: this.cfg.idleTimeoutSec,
            signal,
            logging: streamLogging(path.join(".afk", "logs", `${agentId}.log`), (line) => this.activity(agentId, line)),
          }),
        );
      } catch (e) {
        if (isRateLimit(e)) throw e;
        if (this.shuttingDown) {
          this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "queued", note: "daemon stopped mid-run — will resume on next start" });
          return done(result("stopped"));
        }
        const userStopped = this.stoppedIds.has(agentId);
        const reason = userStopped
          ? "Stopped by you from the dashboard."
          : `Researcher hit the ${this.cfg.absoluteTimeoutMin}m cap, stalled (idle > ${this.cfg.idleTimeoutSec / 60}m), or errored before finishing.`;
        this.escalate(p.number, p.title, reason, userStopped ? "" : `\n\`\`\`\n${String((e as Error)?.message ?? e).slice(0, 800)}\n\`\`\``);
        const status: "stopped" | "error" = userStopped ? "stopped" : "error";
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: status });
        return done(result(status));
      }

      const route = routeResearch(
        readJson(path.join(afk, "question.json")) as { question?: string; detail?: string } | null,
        readJson(path.join(afk, "blocked.json")) as { reason?: string; detail?: string } | null,
        readText(path.join(afk, "research.md")),
      );
      if (route.action === "question") {
        this.ask(p, route.q); // no branch — research work is never preserved
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "question" });
        return done(result("question"));
      }
      if (route.action === "escalate") {
        this.escalate(p.number, p.title, route.reason, route.detail);
        this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "blocked" });
        return done(result("blocked"));
      }

      // (a) the findings ARE the resolution comment — clearly AFK-authored and unreviewed.
      gh(["issue", "comment", String(p.number), "--body",
        `> *Posted by AFK.*\n\n## 🔍 Research findings — AFK-authored, unreviewed\n\n${route.findings}`]);
      // (b) auto-close is the chosen policy: drop the ready label and close the ticket.
      try { gh(["issue", "edit", String(p.number), "--remove-label", this.cfg.labelReady]); } catch { /* label may not exist */ }
      gh(["issue", "close", String(p.number)]);
      // (c) one-line pointer COMMENT on the parent (the map) — NEVER an edit to its body; the next
      // /wayfinder session folds pointers into `## Decisions so far`.
      if (p.featureKey?.startsWith("epic-")) {
        const parent = p.featureKey.replace("epic-", "");
        try {
          gh(["issue", "comment", parent, "--body",
            `> *Posted by AFK.*\n\n🔍 Research resolved: **${p.title}** — see #${p.number}. Fold into Decisions-so-far next session.`]);
        } catch (e) { this.log(`  ⚠️  #${p.number}: couldn't post the pointer comment on parent #${parent}: ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
      }
      this.log(`  🔍 #${p.number}: research findings posted — issue closed.`);
      this.emit({ type: "issue-state", issue: p.number, title: p.title, feature: p.featureKey, state: "researched" });
      return done(result("researched"));
    } finally {
      // Always discard the branch + worktree: research never preserves work (no commits by contract;
      // any the agent made despite instructions die here with the branch).
      const wt = sandbox?.worktreePath;
      if (sandbox) await sandbox.close().catch(() => {});
      await this.withGitLock(() => {
        if (wt) { try { git(["worktree", "remove", "--force", wt]); } catch { /* already gone */ } }
        try { git(["branch", "-D", p.branch]); } catch { /* gone / checked out */ }
      });
    }
  }

  /** Post-implement review pass — best-effort, in the SAME warm sandbox the Implementer used, on
   *  the committed issue branch, diffing against `diffBase` (the feature branch for grouped issues,
   *  `origin/<base>` for loose ones). Returns the severe-finding reason (→ caller escalates instead
   *  of landing) or null (→ proceed to landing). Rate-limit errors rethrow like every other agent
   *  path; any other failure logs a warning and lands anyway. Skips with one log line when the repo
   *  has no `.sandcastle/review-prompt.md` (scaffolded before this feature — re-run `afk init`). */
  private async reviewIssue(sandbox: sandcastle.Sandbox, p: Picked, issueJson: string, diffBase: string): Promise<string | null> {
    if (this.shuttingDown) return null;
    if (!fs.existsSync(path.join(sandbox.worktreePath, ".sandcastle", "review-prompt.md"))) {
      this.log(`  🔎 #${p.number}: no .sandcastle/review-prompt.md in this repo — skipping review (re-run \`afk init\` to scaffold it).`);
      return null;
    }
    const reviewId = `review-${p.number}`;
    const afk = path.join(sandbox.worktreePath, ".afk");
    try { fs.rmSync(path.join(afk, "review.json"), { force: true }); } catch { /* none */ }
    this.log(`  🔎 #${p.number}: reviewing the diff against \`${diffBase}\`…`);
    this.emit({ type: "agent", id: reviewId, role: "review", target: `#${p.number}`, phase: "start" });
    let err: unknown = null;
    try {
      await this.withController(reviewId, this.cfg.absoluteTimeoutMs, (signal) =>
        sandbox.run({
          name: `review-#${p.number}`,
          agent: sandcastle.claudeCode(this.cfg.models.review, { env: { CLAUDE_CODE_OAUTH_TOKEN: this.cfg.oauth } }),
          promptFile: ".sandcastle/review-prompt.md",
          completionSignal: "<promise>COMPLETE</promise>",
          maxIterations: 1,
          promptArgs: { ISSUE_NUMBER: String(p.number), ISSUE_TITLE: p.title, BRANCH: p.branch, ISSUE_JSON: issueJson, DIFF_BASE: diffBase },
          idleTimeoutSeconds: this.cfg.idleTimeoutSec,
          signal,
          logging: streamLogging(path.join(".afk", "logs", `${reviewId}.log`), (line) => this.activity(reviewId, line)),
        }),
      );
    } catch (e) { err = e; }
    this.emit({ type: "agent", id: reviewId, role: "review", target: `#${p.number}`, phase: "end" });
    const route = routeReview(err, readJson(path.join(afk, "review.json")));
    if (route.action === "rethrow") throw err;
    if (route.action === "escalate") return route.reason;
    if (route.warn) this.log(`  ⚠️  #${p.number}: Reviewer failed (${route.warn}) — landing anyway (review is best-effort).`);
    return null;
  }

  /** Push a loose issue's branch and open (or refresh) its own PR against the base branch. The PR
   *  body carries `Closes #N`, so the issue closes when the PR merges. A `liveVerify` issue's PR
   *  opens as a DRAFT + `verify:live-pending` label — a human owes it a live pass before merge.
   *  Returns the PR url or null. */
  private openIssuePR(p: Picked, summary: string): string | null {
    try { git(["push", "-u", "origin", p.branch]); }
    catch (e) {
      this.log(`  ⚠️  #${p.number}: couldn't push ${p.branch}: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
      return null;
    }
    const liveNote = p.liveVerify ? `\n\n🔬 **Draft pending a live verification pass** — requested via \`Verify (live)\` in #${p.number}.` : "";
    const body = `> *Opened by AFK.*\n\nCloses #${p.number}${liveNote}\n\n${summary}`;
    let url: string | null;
    try {
      url = gh(["pr", "create", "--base", p.base, "--head", p.branch, "--title", `feat: ${p.title} (#${p.number})`, "--body", body, ...(p.liveVerify ? ["--draft"] : [])]).trim();
    } catch {
      // A PR for this branch may already exist (re-run) — refresh its body and return its url.
      try { gh(["pr", "edit", p.branch, "--body", body]); } catch { /* ignore */ }
      // The live-verify draft decision must also apply to an existing PR that's already ready.
      if (p.liveVerify) { try { gh(["pr", "ready", p.branch, "--undo"]); } catch (e) { this.log(`  ⚠️  #${p.number}: couldn't convert the PR back to draft: ${String((e as Error)?.message ?? e).split("\n")[0]}`); } }
      try { url = gh(["pr", "view", p.branch, "--json", "url", "-q", ".url"]).trim(); } catch { url = null; }
    }
    if (url && p.liveVerify) this.addLiveVerifyLabel(p.branch, `#${p.number}`);
    return url;
  }

  /** Best-effort `verify:live-pending` label — the label may not exist in the repo, so a failure is
   *  only a logged warning, never a failed landing. */
  private addLiveVerifyLabel(branch: string, target: string): void {
    try { gh(["pr", "edit", branch, "--add-label", LIVE_VERIFY_LABEL]); }
    catch (e) { this.log(`  ⚠️  ${target}: couldn't add the ${LIVE_VERIFY_LABEL} label: ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
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
      return out.commits > 0 && !out.blocked && this.branchAhead(p.feature, this.baseRef(p.base) ?? p.base);
    } catch (e) {
      if (isRateLimit(e)) throw e;
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
        const bodyMatched = (JSON.parse(gh(["issue", "list", "--state", "all", "--json", "number,state,body,labels", "--limit", "200"])) as typeof all)
          .filter((i) => /##\s*Parent/i.test(i.body ?? "") && re.test(i.body ?? ""));
        all = unionChildren(bodyMatched, this.epicSubIssues(Number(epicNum)));
      }
      const hasReady = (i: { labels?: { name: string }[] }) => (i.labels ?? []).some((l) => l.name === this.cfg.labelReady);
      const openReady = all.filter((i) => i.state === "OPEN" && hasReady(i)).map((i) => i.number);
      const landed = all.filter((i) => i.state === "CLOSED").map((i) => i.number);
      return { openReady, landed };
    } catch { return { openReady: [], landed: [] }; }
  }

  /** The epic's NATIVE sub-issues via one GraphQL query — the planner groups children this way, so
   *  body-text `## Parent` matches alone would miss them (→ premature `isFeatureComplete`). GraphQL
   *  issue state is `OPEN`/`CLOSED`, same as the REST path. A failure degrades to body-text-only
   *  children with one warning — never throws. */
  private epicSubIssues(epicNum: number): { number: number; state: string; labels?: { name: string }[] }[] {
    const [owner, name] = this.cfg.nwo.split("/");
    try {
      const data = JSON.parse(gh(["api", "graphql", "-f",
        `query=query { repository(owner: "${owner}", name: "${name}") { issue(number: ${epicNum}) { subIssues(first: 100) { nodes { number state labels(first: 20) { nodes { name } } } } } } }`]));
      return (data?.data?.repository?.issue?.subIssues?.nodes ?? []).map((n: any) => ({
        number: n.number, state: n.state, labels: (n.labels?.nodes ?? []).map((l: any) => ({ name: l.name })),
      }));
    } catch (e) {
      this.log(`  ⚠️  couldn't fetch native sub-issues for epic #${epicNum} (${String((e as Error)?.message ?? e).split("\n")[0]}) — using body-text \`## Parent\` children only.`);
      return [];
    }
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
    if (feature.branch === feature.base) return; // legacy: no PR for base-branch merges
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
    if (feature.branch === feature.base || feature.merged.length === 0) return null;
    // Push by refspec — no host checkout is ever needed to publish the feature branch. A failed
    // push is only benign when origin already has our HEAD; otherwise the PR head is stale and
    // must NOT be promoted to ready (the verified commits never reached origin).
    let pushFailed = false;
    try { git(["push", "origin", feature.branch]); }
    catch (e) {
      const upToDate = (() => {
        try { return git(["rev-parse", `refs/remotes/origin/${feature.branch}`]).trim() === git(["rev-parse", feature.branch]).trim(); }
        catch { return false; }
      })();
      if (!upToDate) {
        pushFailed = true;
        this.log(`  ⚠️  ${feature.branch}: push failed (${String((e as Error)?.message ?? e).split("\n")[0]}) — the PR head is stale, keeping it a draft.`);
      }
    }

    const incomplete = this.featureChildren(feature).openReady.length > 0;
    const closes = this.landedChildren(feature).map((n) => `Closes #${n}`).join("\n");

    let status: string; let state: "draft" | "ready";
    if (incomplete) { status = `⏳ Feature not complete yet — draft until all child issues land.`; state = "draft"; }
    else if (v.verdict?.ok) { status = `${verdictMarkdown(v.verdict)}${v.evidenceMd}`; state = "ready"; }
    else if (v.verdict && !v.verdict.ok) { status = `${verdictMarkdown(v.verdict)}${v.evidenceMd}\n\n🛑 Verification failed and the Fixer couldn't make it green — needs a human.`; state = "draft"; }
    else { status = `⚠️ **Unverified** — ${v.unverifiedReason}. Tests pass per the implementers, but AFK couldn't run an end-to-end check on this host. Please test manually before merging.`; state = "ready"; }
    // A live-verification request on ANY landed child keeps the PR a draft until a human passes it.
    const livePending = feature.liveVerify.length > 0;
    if (livePending) {
      status += `\n\n🔬 **Draft pending a live verification pass** — requested via \`Verify (live)\` in ${feature.liveVerify.map((n) => `#${n}`).join(", ")}.`;
      state = "draft";
    }
    if (pushFailed) {
      status += `\n\n⚠️ **push failed — PR head is stale.** The locally verified commits never reached origin; push \`${feature.branch}\` manually and re-run.`;
      state = "draft";
    }

    const body = `> *Opened by AFK.*\n\nImplements **${feature.title}**.\n\n${closes}\n\n${status}`;
    const url = this.createOrUpdatePR(feature.branch, feature.base, feature.title, body, state === "draft");
    if (url && livePending) this.addLiveVerifyLabel(feature.branch, feature.title);
    if (url) this.emit({ type: "pr", feature: feature.key, url, state });
    // One feature-state: building (incomplete) · verified (green) · needs-human (verify failed) · unverified.
    const fState = incomplete ? "building" : v.verdict?.ok ? "verified" : v.verdict ? "needs-human" : "unverified";
    this.emit({ type: "feature-state", feature: feature.key, title: feature.title, state: fState });
    return url;
  }

  private createOrUpdatePR(branch: string, base: string, title: string, body: string, draft: boolean): string | null {
    try {
      return gh(["pr", "create", "--base", base, "--head", branch, "--title", `feat: ${title}`, "--body", body, ...(draft ? ["--draft"] : [])]).trim();
    } catch {
      try { gh(["pr", "edit", branch, "--body", body]); } catch { /* ignore */ }
      if (!draft) {
        // The durable hold lives on the PR itself: batch runs have no reconcile, so in-memory
        // `liveVerify` may be empty — the label blocks promotion until a human removes it.
        if (this.prHasLiveHold(branch)) this.log(`  🔬 ${branch}: ${LIVE_VERIFY_LABEL} is on the PR — keeping it a draft until a human removes the label.`);
        else { try { gh(["pr", "ready", branch]); } catch { /* already ready */ } }
      } else {
        // A draft decision must also apply to a PR that's already ready.
        try { gh(["pr", "ready", branch, "--undo"]); } catch (e) { this.log(`  ⚠️  ${branch}: couldn't convert the PR back to draft: ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
      }
      try { return gh(["pr", "view", branch, "--json", "url", "-q", ".url"]).trim(); } catch { return null; }
    }
  }

  /** True when the PR on `branch` carries the durable `verify:live-pending` hold label. A read
   *  failure returns false (same promotion behavior as before the label check existed). */
  private prHasLiveHold(branch: string): boolean {
    try {
      const labels: { name: string }[] = JSON.parse(gh(["pr", "view", branch, "--json", "labels"]))?.labels ?? [];
      return labels.some((l) => l.name === LIVE_VERIFY_LABEL);
    } catch { return false; }
  }
}
