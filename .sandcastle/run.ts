/**
 * AFK orchestrator — drains the `ready-for-agent` issue queue while you sleep.
 *
 *   host (this file, deterministic):  plan → merge → verify gate → report → close
 *   container (per issue, one agent):  implement → write spec → run afk-gate → write summary
 *
 * The host owns every GitHub mutation and the merge decision. The worker only
 * produces artifacts in the bind-mounted worktree (.afk/gate.json, .afk/summary.md,
 * .afk/video.webm) and commits its code. The worker has no GitHub credentials.
 *
 * Run from the project root:  npx tsx .sandcastle/run.ts
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
loadDotenv(path.join(os.homedir(), ".afk", ".env"));     // global token (set once by install)
const WORKER_IMAGE = "afk-worker";                       // shared image, built once

const BASE_BRANCH: string = CFG.baseBranch ?? "master";
const MAX_PARALLEL: number = CFG.maxParallel ?? 2;
const MAX_ISSUES: number = CFG.maxIssuesPerRun ?? 5;
const ISSUE_TIMEOUT_MS: number = (CFG.issueTimeoutMin ?? 30) * 60_000;
const MODEL: string = CFG.model ?? "opus";
const PUSH: boolean = CFG.push ?? false;
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
  if (!v) { console.error(`Missing required env var: ${name} (set it in .sandcastle/.env)`); process.exit(1); }
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

// ── deterministic planner ────────────────────────────────────────────────────
type Issue = { number: number; title: string; body: string };
type Picked = { number: number; title: string; branch: string };

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
    gh(["issue", "list", "--label", L_READY, "--state", "open", "--json", "number,title,body", "--limit", "100"]),
  );
  const out: Picked[] = [];
  for (const i of ready) {
    const { refs, freeText } = blockersOf(i.body ?? "");
    if (freeText) { escalate(i.number, "Ambiguous `Blocked by` (no `#N` reference). Needs a human to clarify the dependency."); continue; }
    if (refs.some((r) => !isClosed(r))) continue; // still blocked — try a later round
    out.push({ number: i.number, title: i.title, branch: `afk/issue-${i.number}` });
    if (out.length >= remaining) break;
  }
  return out;
}

// ── reporting side-effects (host only) ───────────────────────────────────────
function escalate(num: number, reason: string, detail = ""): void {
  gh(["issue", "comment", String(num), "--body",
    `> *Posted by AFK.*\n\n🛑 **Could not finish autonomously.**\n\n${reason}\n${detail}`]);
  try { gh(["issue", "edit", String(num), "--remove-label", L_READY, "--add-label", L_HUMAN]); } catch { /* labels may not exist */ }
}
let releaseReady = false;
function ensureRelease(): void {
  if (releaseReady) return;
  try { gh(["release", "view", RELEASE_TAG]); }
  catch { gh(["release", "create", RELEASE_TAG, "--title", "AFK artifacts", "--notes", "Auto-generated feature videos.", "--latest=false"]); }
  releaseReady = true;
}
function uploadVideo(num: number, videoPath: string): string {
  ensureRelease();
  const named = path.join(path.dirname(videoPath), `issue-${num}.webm`);
  fs.copyFileSync(videoPath, named);
  gh(["release", "upload", RELEASE_TAG, named, "--clobber"]);
  return `https://github.com/${NWO}/releases/download/${RELEASE_TAG}/issue-${num}.webm`;
}

// ── per-issue pipeline ───────────────────────────────────────────────────────
type Result = { num: number; title: string; status: string; video?: string };

async function processIssue(p: Picked, results: Result[]): Promise<void> {
  const issueJson = gh(["issue", "view", String(p.number), "--json", "title,body,comments"]);
  let sandbox: sandcastle.Sandbox | undefined;
  try {
    sandbox = await sandcastle.createSandbox({
      sandbox: docker({ imageName: WORKER_IMAGE }),
      branch: p.branch,
      baseBranch: BASE_BRANCH,
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
    } finally { clearTimeout(timer); }

    // read the deterministic verdict the afk-gate SCRIPT wrote (not the agent's prose)
    const afk = path.join(sandbox.worktreePath, ".afk");
    const gate = readJson(path.join(afk, "gate.json"));
    const summary = readText(path.join(afk, "summary.md")) ?? "_(worker wrote no summary)_";
    const videoPath = path.join(afk, "video.webm");

    if (commits === 0) { results.push({ num: p.number, title: p.title, status: "no-commits" }); escalate(p.number, "The worker produced no commits."); return; }
    if (!gate) { results.push({ num: p.number, title: p.title, status: "no-gate" }); escalate(p.number, "No `.afk/gate.json` — the worker never ran `afk-gate`, so nothing is verified."); return; }

    const e2e: string = gate.e2e ?? "skip"; // pass | fail | noboot | skip
    const green = gate.typecheck === true && gate.unit === true && e2e !== "fail";
    if (!green) {
      results.push({ num: p.number, title: p.title, status: "gate-fail" });
      escalate(p.number, "Verification gate failed — not merging.",
        `\n| check | result |\n|---|---|\n| typecheck | ${verdict(gate.typecheck)} |\n| unit | ${verdict(gate.unit)} |\n| e2e | \`${e2e}\` |\n\n<details><summary>gate log</summary>\n\n\`\`\`\n${(gate.log ?? "").slice(-4000)}\n\`\`\`\n</details>`);
      return;
    }

    // ── merge on host ──
    git(["checkout", BASE_BRANCH]);
    try { git(["merge", "--no-ff", p.branch, "-m", `AFK: ${p.title} (closes #${p.number})`]); }
    catch { git(["merge", "--abort"]); results.push({ num: p.number, title: p.title, status: "conflict" }); escalate(p.number, `Merge conflict with \`${BASE_BRANCH}\`. Needs a human to resolve.`); return; }
    if (PUSH) git(["push", "origin", BASE_BRANCH]);

    // ── report ──
    const video = fs.existsSync(videoPath) ? uploadVideo(p.number, videoPath) : undefined;
    const vidLine = video ? `\n\n🎥 [Watch the feature in action](${video})` : "";
    const flag = e2e === "noboot" ? "\n\n🚩 **e2e unverified** — the dev server didn't boot in-container, so only typecheck + unit gated this merge." : "";
    gh(["issue", "comment", String(p.number), "--body", `> *Posted by AFK.*\n\n✅ **Done & merged to \`${BASE_BRANCH}\`.**\n\n${summary}${vidLine}${flag}`]);
    gh(["issue", "close", String(p.number)]);
    results.push({ num: p.number, title: p.title, status: e2e === "noboot" ? "merged-unverified" : "merged", video });
  } finally {
    if (sandbox) await sandbox.close().catch(() => {});
    try { git(["branch", "-D", p.branch]); } catch { /* may already be gone */ }
  }
}

const verdict = (v: unknown) => (v === true ? "✅ pass" : "❌ fail");
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
  console.log(`AFK starting on ${NWO} — base=${BASE_BRANCH}, parallel=${MAX_PARALLEL}, cap=${MAX_ISSUES}, push=${PUSH}\n`);
  const results: Result[] = [];
  let stopped = false;
  let processed = 0;

  while (!stopped && processed < MAX_ISSUES) {
    const batch = pick(MAX_ISSUES - processed);
    if (batch.length === 0) break;
    console.log(`Round: ${batch.map((b) => `#${b.number}`).join(", ")}`);

    await pool(batch, MAX_PARALLEL, async (p) => {
      try { await processIssue(p, results); }
      catch (e) {
        if (isRateLimit(e)) { stopped = true; console.error(`\n⏸  Rate limit hit — stopping cleanly. Remaining issues stay ${L_READY}.`); }
        else { console.error(`✗ #${p.number}:`, e); escalate(p.number, "Unexpected orchestrator error.", `\n\`\`\`\n${String(e).slice(0, 1500)}\n\`\`\``); results.push({ num: p.number, title: p.title, status: "error" }); }
      }
    });
    processed += batch.length;
  }

  // ── morning roll-up ──
  const icon: Record<string, string> = { merged: "✅", "merged-unverified": "🚩", "gate-fail": "❌", conflict: "⚠️", "no-commits": "∅", "no-gate": "❓", error: "💥" };
  const lines = results.map((r) => `${icon[r.status] ?? "•"} #${r.num} ${r.title}  — ${r.status}${r.video ? `  ([video](${r.video}))` : ""}`);
  const merged = results.filter((r) => r.status.startsWith("merged")).length;
  const report = [
    `# AFK run report`,
    ``,
    `**${merged}** merged to \`${BASE_BRANCH}\`${PUSH ? " and pushed" : " (not pushed)"}, **${results.length - merged}** need a human.`,
    ``,
    ...lines,
    ``,
    ...(PUSH ? [] : [`> Review with \`git log ${BASE_BRANCH}\`, then \`git push\` when you're happy.`]),
    `> Sweep the rest with \`/triage\`.`,
  ].join("\n");
  fs.writeFileSync("AFK-REPORT.md", report);
  console.log(`\n${report}\n\nWritten to AFK-REPORT.md`);
})();
