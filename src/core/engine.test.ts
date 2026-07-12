/**
 * Landing-flow tests for the host-tree-free contract. `mergeInWorktree` runs against a REAL temp
 * git repo (no Docker, no GitHub, no LLM) and must land/route merges while leaving the host
 * worktree completely untouched — even mid-edit. That "host tree mutated by afk" failure mode is
 * exactly the regression this suite plants a flag on. Run with `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { looseIssue, mergeInWorktree, routeResearch, routeReview, unionChildren } from "./engine.js";
import { deriveFeature } from "./planner.js";

const G = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A real repo with one commit on `main`, checked out — the developer's host tree. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-landing-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  G(dir, ["config", "user.email", "afk@test.local"]);
  G(dir, ["config", "user.name", "afk-test"]);
  G(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  G(dir, ["add", "."]);
  G(dir, ["commit", "-m", "base"]);
  return dir;
}
/** Create `branch` from `from`, commit one file change on it (leaves `branch` checked out). */
function commitOn(dir: string, branch: string, from: string, file: string, content: string, msg: string): void {
  G(dir, ["checkout", "-q", "-b", branch, from]);
  fs.writeFileSync(path.join(dir, file), content);
  G(dir, ["add", "."]);
  G(dir, ["commit", "-m", msg]);
}
const mergeWorktrees = (dir: string) =>
  [...G(dir, ["worktree", "list", "--porcelain"]).matchAll(/_merge-/g)].length;
const cleanup = (dir: string) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file lock — temp dir, OS reaps it */ } };

// ── landing route: loose vs grouped ──────────────────────────────────────────
test("landing route: loose issue (no epic/milestone) opens its own PR; grouped issues merge to their feature", () => {
  const loose = deriveFeature({ epicNum: null, epicTitle: null, milestoneTitle: null }, "main");
  assert.equal(looseIssue({ feature: loose.branch, featureKey: loose.featureKey }, "main"), true);
  const epic = deriveFeature({ epicNum: 7, epicTitle: "Roleplay History", milestoneTitle: null }, "main");
  assert.equal(looseIssue({ feature: epic.branch, featureKey: epic.featureKey }, "main"), false);
  const ms = deriveFeature({ epicNum: null, epicTitle: null, milestoneTitle: "Billing" }, "main");
  assert.equal(looseIssue({ feature: ms.branch, featureKey: ms.featureKey }, "main"), false);
});

// ── mergeInWorktree: clean merge ─────────────────────────────────────────────
test("mergeInWorktree: clean merge lands --no-ff on the feature branch and never touches the host tree", () => {
  const dir = makeRepo();
  try {
    G(dir, ["branch", "feat/1-x", "main"]);
    commitOn(dir, "afk/issue-1", "feat/1-x", "b.txt", "issue work\n", "issue 1");
    G(dir, ["checkout", "-q", "main"]);
    // The developer is mid-edit in the host tree — the exact situation the old checkout+merge broke.
    fs.writeFileSync(path.join(dir, "a.txt"), "developer edit in progress\n");
    const headBefore = G(dir, ["rev-parse", "HEAD"]);

    assert.equal(mergeInWorktree("feat/1-x", "afk/issue-1", "feat: x (#1)", { repoDir: dir }), "ok");

    // The merge landed: issue commit + merge commit ahead of main, with the merge message.
    assert.equal(G(dir, ["rev-list", "--count", "main..feat/1-x"]), "2");
    assert.match(G(dir, ["log", "-1", "--format=%s", "feat/1-x"]), /\(#1\)/);
    // Host tree untouched: same branch, same HEAD, developer's uncommitted edit intact.
    assert.equal(G(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(G(dir, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "developer edit in progress\n");
    // The throwaway worktree was removed.
    assert.equal(mergeWorktrees(dir), 0);
  } finally { cleanup(dir); }
});

// ── mergeInWorktree: conflict ────────────────────────────────────────────────
test("mergeInWorktree: conflicting merge returns 'conflict', aborts in the throwaway, leaves everything untouched", () => {
  const dir = makeRepo();
  try {
    commitOn(dir, "feat/2-y", "main", "a.txt", "feature version\n", "feature edit");
    commitOn(dir, "afk/issue-2", "main", "a.txt", "issue version\n", "issue edit");
    G(dir, ["checkout", "-q", "main"]);
    const featHead = G(dir, ["rev-parse", "feat/2-y"]);

    assert.equal(mergeInWorktree("feat/2-y", "afk/issue-2", "feat: y (#2)", { repoDir: dir }), "conflict");

    // Feature branch unchanged, no merge left in progress anywhere, host tree clean on main.
    assert.equal(G(dir, ["rev-parse", "feat/2-y"]), featHead);
    assert.equal(G(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(G(dir, ["status", "--porcelain"]), "");
    assert.equal(mergeWorktrees(dir), 0);
  } finally { cleanup(dir); }
});

// ── mergeInWorktree: refuses to start ────────────────────────────────────────
test("mergeInWorktree: target branch checked out in the host tree → 'failed', target left unchanged", () => {
  const dir = makeRepo();
  try {
    G(dir, ["branch", "feat/3-z", "main"]);
    commitOn(dir, "afk/issue-3", "main", "c.txt", "x\n", "issue 3");
    // The developer has the FEATURE branch checked out — git refuses a second worktree on it.
    G(dir, ["checkout", "-q", "feat/3-z"]);
    const featHead = G(dir, ["rev-parse", "feat/3-z"]);

    assert.equal(mergeInWorktree("feat/3-z", "afk/issue-3", "feat: z (#3)", { repoDir: dir }), "failed");

    assert.equal(G(dir, ["rev-parse", "feat/3-z"]), featHead);
    assert.equal(G(dir, ["status", "--porcelain"]), "");
    assert.equal(mergeWorktrees(dir), 0);
  } finally { cleanup(dir); }
});

// ── routeReview: the post-implement review is best-effort ────────────────────
// Planted regression: a review failure must NEVER block a good implement from landing (only a rate
// limit rethrows, only an explicit severe finding escalates) — otherwise adding review would turn
// every reviewer hiccup into a lost landing.
test("routeReview: severe finding in review.json → escalate with the reason", () => {
  assert.deepEqual(routeReview(null, { severe: "missing organizationId filter on the new query" }),
    { action: "escalate", reason: "missing organizationId filter on the new query" });
});
test("routeReview: rate-limit error → rethrow (even if review.json also has a severe finding)", () => {
  assert.deepEqual(routeReview(new Error("Claude usage limit reached"), null), { action: "rethrow" });
  assert.deepEqual(routeReview(new Error("HTTP 429 too many requests"), { severe: "x" }), { action: "rethrow" });
  assert.deepEqual(routeReview(new Error("model overloaded"), null), { action: "rethrow" });
});
test("routeReview: any other reviewer error → proceed to landing, first error line as the warning", () => {
  const r = routeReview(new Error("worker stalled (idle > 10m)\nstack trace..."), null);
  assert.deepEqual(r, { action: "proceed", warn: "worker stalled (idle > 10m)" });
});
test("routeReview: reviewer wrote a severe finding and THEN errored → the finding still escalates", () => {
  assert.deepEqual(routeReview(new Error("worker stalled (idle > 10m)"), { severe: "auth bypass in the new route" }),
    { action: "escalate", reason: "auth bypass in the new route" });
});
test("routeReview: clean run — no review.json, or one without a real severe reason → proceed", () => {
  assert.deepEqual(routeReview(null, null), { action: "proceed" });
  assert.deepEqual(routeReview(null, {}), { action: "proceed" });
  assert.deepEqual(routeReview(null, { severe: "" }), { action: "proceed" });
  assert.deepEqual(routeReview(null, { severe: "   " }), { action: "proceed" });
  assert.deepEqual(routeReview(null, { severe: 42 }), { action: "proceed" });
});

// ── routeResearch: research outcome routing ──────────────────────────────────
// Planted regression: a research run that produced NOTHING must escalate, never silently close the
// issue as "resolved" — and non-empty findings must publish (comment + close), never escalate.
test("routeResearch: non-empty findings → publish (comment + close path)", () => {
  assert.deepEqual(routeResearch(null, null, "Answer: yes.\n\nEvidence: src/x.ts:12"),
    { action: "publish", findings: "Answer: yes.\n\nEvidence: src/x.ts:12" });
});
test("routeResearch: missing or empty findings → escalate, reason names the missing file", () => {
  for (const findings of [null, "", "   \n\t"]) {
    const r = routeResearch(null, null, findings);
    assert.equal(r.action, "escalate");
    assert.match((r as { reason: string }).reason, /no findings file/);
    assert.match((r as { reason: string }).reason, /research\.md/);
  }
});
test("routeResearch: a bail (blocked.json) → escalate with the researcher's reason + detail", () => {
  assert.deepEqual(routeResearch(null, { reason: "needs live Stripe docs", detail: "checked docs/ first" }, null),
    { action: "escalate", reason: "The researcher bailed: needs live Stripe docs.", detail: "\nchecked docs/ first" });
  assert.deepEqual(routeResearch(null, {}, "findings that must not publish"),
    { action: "escalate", reason: "The researcher bailed: blocked.", detail: "" });
});
test("routeResearch: a clarifying question takes priority over everything else", () => {
  assert.deepEqual(routeResearch({ question: "which epoch?" }, { reason: "x" }, "findings"),
    { action: "question", q: { question: "which epoch?" } });
  // an empty question object doesn't count as a question
  assert.equal(routeResearch({}, null, "findings").action, "publish");
});

// ── unionChildren: featureChildren must see NATIVE sub-issue children too ────
// Planted regression: with body-text-only matching, a native-only sibling slice is invisible →
// isFeatureComplete goes true after the first child lands → premature verify + ready feature PR.
test("unionChildren: body-text matches ∪ native sub-issues, deduped by number, body entry wins", () => {
  const body = [{ number: 1, state: "CLOSED" }, { number: 2, state: "OPEN" }];
  const native = [{ number: 2, state: "CLOSED" }, { number: 3, state: "OPEN" }];
  assert.deepEqual(unionChildren(body, native),
    [{ number: 1, state: "CLOSED" }, { number: 2, state: "OPEN" }, { number: 3, state: "OPEN" }]);
});
test("unionChildren: either side empty passes the other through", () => {
  const kids = [{ number: 7, state: "OPEN" }];
  assert.deepEqual(unionChildren([], kids), kids);
  assert.deepEqual(unionChildren(kids, []), kids);
});
