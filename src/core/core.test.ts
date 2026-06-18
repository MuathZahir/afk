/**
 * Unit tests for the deterministic engine core. These run with no Docker, no GitHub, no LLM —
 * they cover exactly the logic that decides routing, grouping, and the dashboard's view, which is
 * where a silent bug would quietly mis-route real work. Run with `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "./sh.js";
import { blockersOf, parentIssueNumber, deriveFeature } from "./planner.js";
import { classifyVerdict, classifyError } from "./classify.js";
import { reduce, type Event } from "./state.js";
import type { Verdict } from "./types.js";

// ── slug ────────────────────────────────────────────────────────────────────
test("slug: lowercases, hyphenates, trims, caps length", () => {
  assert.equal(slug("Roleplay History!"), "roleplay-history");
  assert.equal(slug("  --Weird__Title--  "), "weird-title");
  assert.equal(slug(""), "feature");
  assert.ok(slug("x".repeat(80)).length <= 50);
});

// ── blockersOf ────────────────────────────────────────────────────────────────
test("blockersOf: parses #N and issue URLs, dedupes", () => {
  const body = "## Blocked by\n#12 and https://github.com/o/r/issues/13 and #12\n## Next";
  assert.deepEqual(blockersOf(body), { refs: [12, 13], freeText: false });
});
test("blockersOf: 'none' means no blockers", () => {
  assert.deepEqual(blockersOf("## Blocked by\nNone\n"), { refs: [], freeText: false });
});
test("blockersOf: free text with no ref is flagged ambiguous", () => {
  assert.deepEqual(blockersOf("## Blocked by\nthe auth thing being done"), { refs: [], freeText: true });
});
test("blockersOf: absent section is not ambiguous", () => {
  assert.deepEqual(blockersOf("just a body"), { refs: [], freeText: false });
});

// ── parentIssueNumber ───────────────────────────────────────────────────────
test("parentIssueNumber: short ref and URL", () => {
  assert.equal(parentIssueNumber("## Parent\n#42\n"), 42);
  assert.equal(parentIssueNumber("## Parent\nhttps://github.com/o/r/issues/99"), 99);
  assert.equal(parentIssueNumber("no parent here"), null);
});

// ── deriveFeature ─────────────────────────────────────────────────────────────
test("deriveFeature: epic parent wins, branch is feat/<n>-<slug>", () => {
  assert.deepEqual(
    deriveFeature({ epicNum: 7, epicTitle: "Roleplay History", milestoneTitle: "Old MS" }, "main"),
    { featureKey: "epic-7", branch: "feat/7-roleplay-history", featureTitle: "Roleplay History" },
  );
});
test("deriveFeature: milestone is the legacy fallback", () => {
  assert.deepEqual(
    deriveFeature({ epicNum: null, epicTitle: null, milestoneTitle: "Billing" }, "main"),
    { featureKey: "ms-billing", branch: "feat/billing", featureTitle: "Billing" },
  );
});
test("deriveFeature: neither → base branch, null key", () => {
  assert.deepEqual(
    deriveFeature({ epicNum: null, epicTitle: null, milestoneTitle: null }, "develop"),
    { featureKey: null, branch: "develop", featureTitle: null },
  );
});

// ── classify ──────────────────────────────────────────────────────────────────
const verdict = (over: Partial<Verdict>): Verdict => ({ ok: false, summary: "", criteria: [], ...over });

test("classifyVerdict: failed criteria → logic", () => {
  assert.equal(classifyVerdict(verdict({ criteria: [{ criterion: "login works", pass: false }] })).kind, "logic");
});
test("classifyVerdict: env signal beats criteria", () => {
  assert.equal(classifyVerdict(verdict({ summary: "cannot connect to the docker daemon", criteria: [{ criterion: "x", pass: false }] })).kind, "env");
});
test("classifyVerdict: transient → flaky", () => {
  assert.equal(classifyVerdict(verdict({ failureDetail: "socket hang up to upstream" })).kind, "flaky");
});
test("classifyVerdict: ok-false but nothing failed → ambiguous", () => {
  assert.equal(classifyVerdict(verdict({ criteria: [{ criterion: "x", pass: true }] })).kind, "ambiguous");
});
test("classifyError: merge conflict text → conflict", () => {
  assert.equal(classifyError("Automatic merge failed; fix conflicts").kind, "conflict");
});

// ── state reducer ───────────────────────────────────────────────────────────
test("reduce: folds issue/feature/pr/escalation/verdict into a snapshot", () => {
  const t = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();
  const events: Event[] = [
    { ts: t(0), type: "daemon", status: "polling" },
    { ts: t(1), type: "issue-state", issue: 12, title: "A", feature: "feat/7-x", state: "implementing" },
    { ts: t(2), type: "issue-state", issue: 12, title: "A", feature: "feat/7-x", state: "merged" },
    { ts: t(3), type: "verdict", feature: "feat/7-x", ok: true, summary: "all good", passed: 3, total: 3 },
    { ts: t(4), type: "pr", feature: "feat/7-x", url: "http://pr/1", state: "ready" },
    { ts: t(5), type: "escalation", issue: 13, title: "B", reason: "stuck" },
    { ts: t(6), type: "agent", id: "a1", role: "implement", target: "#12", phase: "start" },
    { ts: t(7), type: "agent", id: "a1", role: "implement", target: "#12", phase: "end", tokens: 500 },
  ];
  const s = reduce(events);
  assert.equal(s.daemon.status, "polling");
  assert.equal(s.issues[12].state, "merged");
  assert.equal(s.totals.merged, 1);
  assert.equal(s.features["feat/7-x"].verdict?.ok, true);
  assert.equal(s.features["feat/7-x"].pr?.state, "ready");
  assert.equal(s.totals.verified, 1);
  assert.equal(s.escalations.length, 1);
  assert.equal(s.totals.escalated, 1);
  assert.equal(s.agents["a1"].active, false);
  assert.equal(s.totals.tokens, 500);
});

test("reduce: merged counted once even if re-emitted", () => {
  const t = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();
  const s = reduce([
    { ts: t(0), type: "issue-state", issue: 1, title: "A", feature: null, state: "merged" },
    { ts: t(1), type: "issue-state", issue: 1, title: "A", feature: null, state: "merged" },
  ]);
  assert.equal(s.totals.merged, 1);
});

test("reduce: question then answer attaches the answer", () => {
  const t = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();
  const s = reduce([
    { ts: t(0), type: "question", id: "q1", issue: 5, prompt: "which DB?" },
    { ts: t(1), type: "answer", id: "q1", answer: "postgres" },
  ]);
  assert.equal(s.questions["q1"].answer, "postgres");
});
