/**
 * AFK orchestrator — drains the `ready-for-agent` issue queue while you sleep.
 *
 *   host (this file, deterministic):  plan → route to feature branch → merge → open PR → report
 *   container (per issue, one agent):  implement → run own tests → commit → write summary
 *
 * Feature model: each issue's GitHub **milestone** is its feature. All issues of a milestone land
 * on ONE branch `feat/<slug>` (not master); when the milestone's work is done the host opens a
 * single PR `feat/<slug> → base` for you to test and merge. Issues with no milestone fall back to
 * merging straight to the base branch (legacy behaviour).
 *
 * No host gate: the host trusts the agent's committed, self-tested branch (the agent runs the
 * tests covering its change and only commits when they pass). You review the feature PR before
 * merging — that's the safety net, not a re-run of the suite here.
 *
 * Runs from the project root via the `afk run` CLI (or `npx tsx <afk>/src/run.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ── config + env ────────────────────────────────────────────────────────────
const CFG = JSON.parse(fs.readFileSync(".sandcastle/afk.config.json", "utf8"));
loadDotenv(".sandcastle/.env");                          // optional per-project override
loadDotenv(path.join(os.homedir(), ".afk", ".env"));     // global token (set once by `afk init`)
const WORKER_IMAGE = "afk-worker";                       // shared image, built once

const BASE_BRANCH: string = CFG.baseBranch ?? "main";
const MAX_PARALLEL: number = CFG.maxParallel ?? 2;
const MAX_ISSUES: number = CFG.maxIssuesPerRun ?? 5;
const ISSUE_TIMEOUT_MS: number = (CFG.issueTimeoutMin ?? 30) * 60_000;
const MODEL: string = CFG.model ?? "opus";
const L_READY: string = CFG.labels?.ready ?? "ready-for-agent";
const L_HUMAN: string = CFG.labels?.human ?? "ready-for-human";
const RELEASE_TAG = "afk-artifacts";

const OAUTH = required("CLAUDE_CODE_OAUTH_TOKEN");
const NWO = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();

// ── small shells ─────────────────────────────────────────────────────────────
function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name} (set it in ~/.afk/.env via \`afk init\`)`); process.exit(1); }
  return v;
}
function loadDotenv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const isRateLimit = (e: unknown): boolean =>
  /rate.?limit|usage limit|quota exceeded|429|overloaded/i.test(String((e as Error)?.message ?? e));
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "feature";

// Serialize host-side git writes — parallel workers share ONE host repo; two concurrent
// `checkout + merge` would corrupt the working tree.
let gitChain: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = gitChain.then(() => fn());
  gitChain = next.catch(() => {});
  return next;
}
const branchAhead = (branch: string, base: string): boolean => {
  try { return Number(git(["rev-list", "--count", `${base}..${branch}`]).trim()) > 0; } catch { return false; }
};

// Ensure the feature branch exists locally: reuse origin's copy if a prior run pushed it, else
// fork it fresh from the base branch. Idempotent and serialized via the git lock.
const featureBranchReady = new Set<string>();
function ensureFeatureBranch(fb: string): void {
  if (fb === BASE_BRANCH || featureBranchReady.has(fb)) return;
  const localExists = git(["branch", "--list", fb]).trim() !== "";
  if (!localExists) {
    const onOrigin = (() => { try { return git(["ls-remote", "--heads", "origin", fb]).trim() !== ""; } catch { return false; } })();
    if (onOrigin) { try { git(["fetch", "origin", `${fb}:${fb}`]); } catch { git(["branch", fb, BASE_BRANCH]); } }
    else git(["branch", fb, BASE_BRANCH]);
  }
  featureBranchReady.add(fb);
}

// SAFETY NET: a worker can finish — or time out — having done real work but never committing it
// (e.g. it exhausted its turn budget). Without this the host counts 0 commits, drops the branch,
// and the work is lost. Instead, commit any uncommitted SOURCE changes on the host so they survive.
// Never stages .afk/ scratch, the .sandcastle harness, lockfiles, or node_modules.
function rescueUncommitted(worktree: string, p: Picked): boolean {
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
    console.log(`  🛟 #${p.number}: rescued ${staged.split("\n").length} uncommitted file(s).`);
    return true;
  } catch (e) {
    console.error(`  ⚠️  #${p.number}: rescue commit failed:`, (e as Error)?.message ?? e);
    return false;
  }
}

// A killed run leaves dirty worktrees that Sandcastle would REUSE — wipe them so every run starts
// clean. Preserved branches were pushed to origin, so dropping local issue worktrees is safe.
function cleanStaleWorktrees(): void {
  try {
    for (const m of git(["worktree", "list", "--porcelain"]).matchAll(/^worktree (.*afk-issue-\d+.*)$/gim)) {
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
    if (ids.length) console.log(`Reaped ${ids.length} orphaned worker container(s) from a prior run.`);
  } catch { /* docker down — createSandbox surfaces it */ }
}

// ── deterministic planner ────────────────────────────────────────────────────
type Milestone = { title: string } | null;
type Issue = { number: number; title: string; body: string; milestone: Milestone };
type Picked = { number: number; title: string; branch: string; feature: string; milestone: string | null };

function blockersOf(body: string): { refs: number[]; freeText: boolean } {
  const m = body.match(/#+\s*Blocked by\s*([\s\S]*?)(?:\n#+\s|\s*$)/i);
  if (!m || /none/i.test(m[1])) return { refs: [], freeText: false };
  const refs = [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
  return { refs, freeText: refs.length === 0 && m[1].trim().length > 0 };
}
const isClosed = (n: number): boolean =>
  JSON.parse(gh(["issue", "view", String(n), "--json", "state"])).state === "CLOSED";

/** Re-queried every round so closing one issue can unblock its dependents in-run. */
function pick(remaining: number): Picked[] {
  const ready: Issue[] = JSON.parse(
    gh(["issue", "list", "--label", L_READY, "--state", "open", "--json", "number,title,body,milestone", "--limit", "100"]),
  );
  const out: Picked[] = [];
  for (const i of ready) {
    const { refs, freeText } = blockersOf(i.body ?? "");
    if (freeText) { escalate(i.number, "Ambiguous `Blocked by` (no `#N` reference). Needs a human to clarify the dependency."); continue; }
    if (refs.some((r) => !isClosed(r))) continue; // still blocked — try a later round
    const milestone = i.milestone?.title ?? null;
    const feature = milestone ? `feat/${slug(milestone)}` : BASE_BRANCH;
    out.push({ number: i.number, title: i.title, branch: `afk/issue-${i.number}`, feature, milestone });
    if (out.length >= remaining) break;
  }
  return out;
}

// ── reporting side-effects (host only) ───────────────────────────────────────
function escalate(num: number, reason: string, detail = "", branch?: string): boolean {
  let preserved = false;
  let branchNote = "";
  if (branch) {
    preserved = true;
    try { git(["push", "-u", "origin", branch]); branchNote = `\n\n🌿 Partial work pushed to branch \`${branch}\`.`; }
    catch { branchNote = `\n\n🌿 Partial work kept on local branch \`${branch}\`.`; }
  }
  gh(["issue", "comment", String(num), "--body",
    `> *Posted by AFK.*\n\n🛑 **Needs a human.**\n\n${reason}\n${detail}${branchNote}`]);
  try { gh(["issue", "edit", String(num), "--remove-label", L_READY, "--add-label", L_HUMAN]); } catch { /* labels may not exist */ }
  return preserved;
}
let releaseReady = false;
function ensureRelease(): void {
  if (releaseReady) return;
  try { gh(["release", "view", RELEASE_TAG]); }
  catch { gh(["release", "create", RELEASE_TAG, "--title", "AFK artifacts", "--notes", "Auto-generated proof-of-work screenshots.", "--latest=false"]); }
  releaseReady = true;
}
function uploadMedia(num: number, afkDir: string): { markdown: string; count: number } {
  const assetUrl = (name: string) => `https://github.com/${NWO}/releases/download/${RELEASE_TAG}/${name}`;
  const upload = (srcPath: string, assetName: string): string => {
    const named = path.join(afkDir, assetName);
    if (path.resolve(srcPath) !== path.resolve(named)) fs.copyFileSync(srcPath, named);
    gh(["release", "upload", RELEASE_TAG, named, "--clobber"]);
    return assetUrl(assetName);
  };
  const gif = path.join(afkDir, "demo.gif");
  const shotsDir = path.join(afkDir, "shots");
  const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort() : [];
  if (!fs.existsSync(gif) && shots.length === 0) return { markdown: "", count: 0 };
  ensureRelease();
  let md = "";
  let count = 0;
  if (fs.existsSync(gif)) { md += `\n\n![demo](${upload(gif, `issue-${num}-demo.gif`)})`; count++; }
  if (shots.length) {
    const imgs = shots.map((s) => `![${s}](${upload(path.join(shotsDir, s), `issue-${num}-${s}`)})`).join("\n\n");
    md += `\n\n<details><summary>Step screenshots (${shots.length})</summary>\n\n${imgs}\n\n</details>`;
    count += shots.length;
  }
  return { markdown: md, count };
}

// Open (or refresh) the single PR for a feature branch. Draft until its milestone has no open
// issues left. Lists `Closes #N` for every issue that landed, so merging the PR closes them all.
type Feature = { milestone: string; merged: number[] };
async function openFeaturePR(fb: string, feat: Feature): Promise<string | null> {
  if (fb === BASE_BRANCH || feat.merged.length === 0) return null;
  try { git(["push", "origin", fb]); } catch { /* may already be up to date */ }
  const openLeft = JSON.parse(gh(["issue", "list", "--milestone", feat.milestone, "--state", "open", "--json", "number"])).length;
  const draft = openLeft > 0;
  const closes = feat.merged.sort((a, b) => a - b).map((n) => `Closes #${n}`).join("\n");
  const status = draft
    ? `⏳ ${openLeft} issue(s) still open in this milestone — draft until the feature is complete.`
    : `✅ All milestone issues complete — ready to test & merge.`;
  const body = `> *Opened by AFK.*\n\nImplements milestone **${feat.milestone}**.\n\n${closes}\n\n${status}`;
  try {
    return gh(["pr", "create", "--base", BASE_BRANCH, "--head", fb, "--title", `feat: ${feat.milestone}`,
      "--body", body, ...(draft ? ["--draft"] : [])]).trim();
  } catch {
    try { gh(["pr", "edit", fb, "--body", body]); } catch { /* ignore */ }
    if (!draft) { try { gh(["pr", "ready", fb]); } catch { /* already ready */ } }
    try { return gh(["pr", "view", fb, "--json", "url", "-q", ".url"]).trim(); } catch { return null; }
  }
}

// ── per-issue pipeline ───────────────────────────────────────────────────────
type Result = { num: number; title: string; status: string; feature: string; media?: number };

async function processIssue(p: Picked, results: Result[], features: Map<string, Feature>): Promise<void> {
  const issueJson = gh(["issue", "view", String(p.number), "--json", "title,body,comments"]);
  await withGitLock(() => ensureFeatureBranch(p.feature));
  let sandbox: sandcastle.Sandbox | undefined;
  let preserve = false;
  let landed = false;
  try {
    sandbox = await sandcastle.createSandbox({
      sandbox: docker({ imageName: WORKER_IMAGE }),
      branch: p.branch,
      baseBranch: p.feature,                                  // build on the feature branch, not base
      hooks: { sandbox: { onSandboxReady: [{ command: CFG.setup ?? "npm ci" }] } },
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`issue #${p.number} exceeded ${CFG.issueTimeoutMin}m`)), ISSUE_TIMEOUT_MS);
    let commits = 0;
    try {
      const r = await sandbox.run({
        name: `impl-#${p.number}`,
        agent: sandcastle.claudeCode(MODEL, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } }),
        promptFile: ".sandcastle/implement-prompt.md",
        completionSignal: "<promise>COMPLETE</promise>",
        promptArgs: { ISSUE_NUMBER: String(p.number), ISSUE_TITLE: p.title, BRANCH: p.branch, ISSUE_JSON: issueJson },
        signal: ac.signal,
      });
      commits = r.commits.length;
    } catch (e) {
      if (isRateLimit(e)) throw e;
      if (sandbox && !branchAhead(p.branch, p.feature)) rescueUncommitted(sandbox.worktreePath, p);
      const reason = ac.signal.aborted ? `Worker timed out after ${CFG.issueTimeoutMin}m.` : "Worker errored before finishing.";
      preserve = escalate(p.number, reason, `\n\`\`\`\n${String((e as Error)?.message ?? e).slice(0, 800)}\n\`\`\``, branchAhead(p.branch, p.feature) ? p.branch : undefined);
      results.push({ num: p.number, title: p.title, status: ac.signal.aborted ? "timeout" : "error", feature: p.feature });
      return;
    } finally { clearTimeout(timer); }

    const afk = path.join(sandbox.worktreePath, ".afk");
    const e2e = readJson(path.join(afk, "e2e.json"));
    const blocked = readJson(path.join(afk, "blocked.json"));
    const summary = readText(path.join(afk, "summary.md")) ?? "_(worker wrote no summary)_";

    const rescued = commits === 0 && rescueUncommitted(sandbox.worktreePath, p);
    if (rescued) commits = 1;
    const workBranch = commits > 0 ? p.branch : undefined;

    if (commits === 0 && !blocked) { results.push({ num: p.number, title: p.title, status: "no-commits", feature: p.feature }); escalate(p.number, "The worker produced no commits and left no uncommitted work to recover."); return; }

    if (blocked) {
      preserve = escalate(p.number, `The worker bailed: ${blocked.reason ?? "blocked"}.`, blocked.detail ? `\n${blocked.detail}` : "", workBranch);
      results.push({ num: p.number, title: p.title, status: "blocked", feature: p.feature });
      return;
    }
    if (rescued) {
      preserve = escalate(p.number, "Worker finished without committing — host recovered its uncommitted work.",
        "The recovered changes are **not** verified — review the feature branch before merging.", workBranch);
      results.push({ num: p.number, title: p.title, status: "rescued", feature: p.feature });
      return;
    }

    // ── merge the issue branch into its feature branch (serialized) ──
    let conflict = false;
    await withGitLock(() => {
      git(["checkout", p.feature]);
      try { git(["merge", "--no-ff", p.branch, "-m", `feat: ${p.title} (#${p.number})`]); }
      catch { git(["merge", "--abort"]); conflict = true; }
    });
    if (conflict) { preserve = escalate(p.number, `Merge conflict with \`${p.feature}\`. Needs a human to resolve.`, "", workBranch); results.push({ num: p.number, title: p.title, status: "conflict", feature: p.feature }); return; }
    landed = true;

    // track for the feature PR, comment + close the issue (the PR will reference it)
    if (p.milestone) {
      const f = features.get(p.feature) ?? { milestone: p.milestone, merged: [] };
      f.merged.push(p.number); features.set(p.feature, f);
    }
    const media = uploadMedia(p.number, afk);
    const verified = e2e?.ok === true ? "\n\n🔎 Verified in the browser: " + (e2e.note ?? "ok") : "";
    const where = p.feature === BASE_BRANCH ? `\`${BASE_BRANCH}\`` : `\`${p.feature}\` (feature branch)`;
    gh(["issue", "comment", String(p.number), "--body",
      `> *Posted by AFK.*\n\n✅ **Done — landed on ${where}.**\n\n${summary}${verified}${media.markdown}`]);
    try { gh(["issue", "edit", String(p.number), "--remove-label", L_READY]); } catch { /* label may not exist */ }
    gh(["issue", "close", String(p.number)]);
    results.push({ num: p.number, title: p.title, status: "merged", feature: p.feature, media: media.count });
  } finally {
    const wt = sandbox?.worktreePath;
    if (sandbox) await sandbox.close().catch(() => {});
    if (landed || !preserve) await withGitLock(() => {
      // close() preserves a worktree that looks dirty (untracked .afk/ scratch), which leaves the
      // issue branch checked out so `branch -D` fails. Force-remove the worktree first.
      if (wt) { try { git(["worktree", "remove", "--force", wt]); } catch { /* already gone */ } }
      try { git(["branch", "-D", p.branch]); } catch { /* gone / checked out */ }
    });
  }
}

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const readText = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

// ── bounded-concurrency pool ─────────────────────────────────────────────────
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

// ── main loop ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`AFK starting on ${NWO} — base=${BASE_BRANCH}, parallel=${MAX_PARALLEL}, cap=${MAX_ISSUES}\n`);
  cleanStaleWorktrees();
  const results: Result[] = [];
  const features = new Map<string, Feature>();
  let stopped = false;
  let processed = 0;

  while (!stopped && processed < MAX_ISSUES) {
    const batch = pick(MAX_ISSUES - processed);
    if (batch.length === 0) break;
    console.log(`Round: ${batch.map((b) => `#${b.number}→${b.feature}`).join(", ")}`);
    await pool(batch, MAX_PARALLEL, async (p) => {
      try { await processIssue(p, results, features); }
      catch (e) {
        if (isRateLimit(e)) { stopped = true; console.error(`\n⏸  Rate limit hit — stopping cleanly. Remaining issues stay ${L_READY}.`); }
        else { console.error(`✗ #${p.number}:`, e); escalate(p.number, "Unexpected orchestrator error.", `\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``); results.push({ num: p.number, title: p.title, status: "error", feature: p.feature }); }
      }
    });
    processed += batch.length;
  }

  // ── open / refresh a PR per feature branch ──
  const prLinks: string[] = [];
  await withGitLock(() => { try { git(["checkout", BASE_BRANCH]); } catch { /* ignore */ } });
  for (const [fb, feat] of features) {
    const url = await openFeaturePR(fb, feat);
    if (url) prLinks.push(`🔀 **${feat.milestone}** → ${url}  (#${feat.merged.sort((a, b) => a - b).join(", #")})`);
  }

  // ── morning roll-up ──
  const icon: Record<string, string> = { merged: "✅", rescued: "♻️", blocked: "🛟", timeout: "⏱️", conflict: "⚠️", "no-commits": "∅", error: "💥" };
  const lines = results.map((r) => `${icon[r.status] ?? "•"} #${r.num} ${r.title}  — ${r.status} → \`${r.feature}\`${r.media ? `  (${r.media} shot${r.media > 1 ? "s" : ""})` : ""}`);
  const mergedN = results.filter((r) => r.status === "merged").length;
  const report = [
    `# AFK run report`, ``,
    `**${mergedN}** issue(s) landed on feature branches, **${results.length - mergedN}** need a human.`, ``,
    ...(prLinks.length ? [`## Feature PRs`, ``, ...prLinks, ``] : []),
    `## Issues`, ``, ...lines, ``,
    `> Check out a feature branch to test it, then merge its PR. Sweep the rest with \`/triage\`.`,
  ].join("\n");
  fs.writeFileSync("AFK-REPORT.md", report);
  console.log(`\n${report}\n\nWritten to AFK-REPORT.md`);
})();
