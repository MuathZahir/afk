/**
 * Unit tests for the deterministic engine core. These run with no Docker, no GitHub, no LLM —
 * they cover exactly the logic that decides routing, grouping, and the dashboard's view, which is
 * where a silent bug would quietly mis-route real work. Run with `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "./sh.js";
import { blockersOf, parentIssueNumber, deriveFeature, ineligibleReason, issueMode, liveVerifyRequested, parseBaseLine, requiresLiveVerify, resolveBase, resolveBlockers, resolveParentIssue } from "./planner.js";
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

// ── ineligibleReason (pickup eligibility — mirrors docs/agents/routing.md) ───
test("ineligibleReason: wayfinder:map label demotes, even with no sub-issues", () => {
  const r = ineligibleReason({ labels: ["wayfinder:map"], subIssuesCount: 0 });
  assert.match(r ?? "", /wayfinder:map/);
  assert.match(r ?? "", /routing\.md/);
});
test("ineligibleReason: native sub-issues make it a parent/epic — demoted", () => {
  const r = ineligibleReason({ labels: ["ready-for-agent"], subIssuesCount: 6 });
  assert.match(r ?? "", /parent\/epic with sub-issues/);
  assert.match(r ?? "", /only slices are AFK-eligible/);
});
test("ineligibleReason: grilling is HITL — demoted, reason names the label", () => {
  assert.match(ineligibleReason({ labels: ["wayfinder:grilling"], subIssuesCount: 0 }) ?? "", /wayfinder:grilling/);
});
test("ineligibleReason: prototype is NO LONGER demoted — building is eligible once a human applied ready", () => {
  assert.equal(ineligibleReason({ labels: ["ready-for-agent", "wayfinder:prototype"], subIssuesCount: 0 }), null);
});
test("ineligibleReason: a plain slice is eligible", () => {
  assert.equal(ineligibleReason({ labels: ["ready-for-agent", "wayfinder:task"], subIssuesCount: 0 }), null);
});
test("ineligibleReason: a research slice is eligible (runs in research mode, not demoted)", () => {
  assert.equal(ineligibleReason({ labels: ["ready-for-agent", "wayfinder:research"], subIssuesCount: 0 }), null);
});

// ── liveVerifyRequested ───────────────────────────────────────────────────────
test("liveVerifyRequested: matches 'Verify (live' in any case/spacing", () => {
  assert.equal(liveVerifyRequested("## Acceptance\nVerify (live): open the dashboard and check the widget."), true);
  assert.equal(liveVerifyRequested("please verify (live, against staging) before merging"), true);
  assert.equal(liveVerifyRequested("VERIFY  (LIVE) required"), true);
});
test("liveVerifyRequested: does not match without the paren or in identifiers", () => {
  assert.equal(liveVerifyRequested("verify live behavior manually"), false);
  assert.equal(liveVerifyRequested("call `liveVerify(spec)` in the test"), false);
  assert.equal(liveVerifyRequested(""), false);
});

// ── requiresLiveVerify (body request OR prototype label — routing.md safety net) ──
test("requiresLiveVerify: the wayfinder:prototype label ALONE forces the live-verify hold", () => {
  assert.equal(requiresLiveVerify("no verify line anywhere in the body", ["ready-for-agent", "wayfinder:prototype"]), true);
});
test("requiresLiveVerify: an explicit body request still works without the label", () => {
  assert.equal(requiresLiveVerify("Verify (live): open the dashboard.", ["ready-for-agent"]), true);
});
test("requiresLiveVerify: neither body request nor label → no hold", () => {
  assert.equal(requiresLiveVerify("plain acceptance criteria", ["ready-for-agent", "wayfinder:task"]), false);
});

// ── issueMode (research detection) ───────────────────────────────────────────
test("issueMode: wayfinder:research label → research mode", () => {
  assert.equal(issueMode(["ready-for-agent", "wayfinder:research"]), "research");
});
test("issueMode: anything else → implement (the default)", () => {
  assert.equal(issueMode(["ready-for-agent", "wayfinder:task"]), "implement");
  assert.equal(issueMode(["ready-for-agent", "wayfinder:prototype"]), "implement");
  assert.equal(issueMode([]), "implement");
});

// ── resolveBlockers: native precedence over body text ─────────────────────────
test("resolveBlockers: an OPEN native blocker blocks — body text ignored", () => {
  const r = resolveBlockers([{ number: 380, state: "OPEN" }, { number: 379, state: "CLOSED" }], "## Blocked by\nNone");
  assert.deepEqual(r, { source: "native", blocked: true, open: [380] });
});
test("resolveBlockers: all native blockers CLOSED → unblocked, no body fallback", () => {
  const r = resolveBlockers([{ number: 12, state: "CLOSED" }], "## Blocked by\n#99");
  assert.deepEqual(r, { source: "native", blocked: false, open: [] });
});
test("resolveBlockers: no native blockers → falls back to the body parse", () => {
  assert.deepEqual(resolveBlockers([], "## Blocked by\n#12"), { source: "body", refs: [12], freeText: false });
  assert.deepEqual(resolveBlockers(null, "## Blocked by\nthe auth thing"), { source: "body", refs: [], freeText: true });
  assert.deepEqual(resolveBlockers(null, "just a body"), { source: "body", refs: [], freeText: false });
});

// ── resolveParentIssue: native sub-issue parent precedence ────────────────────
test("resolveParentIssue: native parent wins over the body `## Parent` section", () => {
  assert.deepEqual(
    resolveParentIssue({ number: 377, title: "Wayfinder: Port Act 2" }, "## Parent\n#42"),
    { num: 377, title: "Wayfinder: Port Act 2" },
  );
});
test("resolveParentIssue: no native parent → body parse (title left for the caller to fetch)", () => {
  assert.deepEqual(resolveParentIssue(null, "## Parent\n#42"), { num: 42, title: null });
});
test("resolveParentIssue: neither → null", () => {
  assert.equal(resolveParentIssue(null, "no parent here"), null);
});

// ── parseBaseLine (per-effort base declaration) ───────────────────────────────
test("parseBaseLine: own line, case-insensitive, optional backticks, CRLF-tolerant", () => {
  assert.equal(parseBaseLine("Intro text\nBase: helix.v2-act2\nmore text"), "helix.v2-act2");
  assert.equal(parseBaseLine("base: `feat/x.y-z`"), "feat/x.y-z");
  assert.equal(parseBaseLine("BASE: main"), "main");
  assert.equal(parseBaseLine("## Details\r\nbase: helix.v2\r\n"), "helix.v2");
});
test("parseBaseLine: first match wins", () => {
  assert.equal(parseBaseLine("base: first\nbase: second"), "first");
});
test("parseBaseLine: mid-line, mid-word, and multi-word lines don't match", () => {
  assert.equal(parseBaseLine("please rebase: main"), null);
  assert.equal(parseBaseLine("the Base: branch of choice"), null);
  assert.equal(parseBaseLine("Base: two words"), null);
  assert.equal(parseBaseLine("no declaration at all"), null);
});

// ── resolveBase (precedence: epic Base → own Base → config) ───────────────────
test("resolveBase: grouped issue — the epic's Base wins; a differing child Base is ignored and reported", () => {
  assert.deepEqual(
    resolveBase({ ownBase: "helix.v2", hasEpic: true, epicBase: "helix.v2-act2", configBase: "main" }),
    { base: "helix.v2-act2", ignoredOwnBase: "helix.v2" },
  );
});
test("resolveBase: grouped issue — child Base matching the epic's resolved base raises no warning", () => {
  assert.deepEqual(
    resolveBase({ ownBase: "helix.v2-act2", hasEpic: true, epicBase: "helix.v2-act2", configBase: "main" }),
    { base: "helix.v2-act2", ignoredOwnBase: null },
  );
});
test("resolveBase: grouped issue — epic declares no Base → config governs; a differing child Base is still ignored", () => {
  assert.deepEqual(
    resolveBase({ ownBase: "helix.v2-act2", hasEpic: true, epicBase: null, configBase: "helix.v2" }),
    { base: "helix.v2", ignoredOwnBase: "helix.v2-act2" },
  );
  assert.deepEqual(
    resolveBase({ ownBase: null, hasEpic: true, epicBase: null, configBase: "helix.v2" }),
    { base: "helix.v2", ignoredOwnBase: null },
  );
});
test("resolveBase: loose issue — its own Base line governs", () => {
  assert.deepEqual(
    resolveBase({ ownBase: "helix.v2-act2", hasEpic: false, epicBase: null, configBase: "helix.v2" }),
    { base: "helix.v2-act2", ignoredOwnBase: null },
  );
});
test("resolveBase: loose issue with no Base line → config fallback", () => {
  assert.deepEqual(
    resolveBase({ ownBase: null, hasEpic: false, epicBase: null, configBase: "main" }),
    { base: "main", ignoredOwnBase: null },
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
