/**
 * Deterministic planner: decide which `ready-for-agent` issues can run now and which feature each
 * belongs to.
 *
 * Metadata source (Phase 2.5): GitHub-native issue metadata is authoritative — native
 * **dependencies** (GraphQL `blockedBy`) decide blocking, native **sub-issues** (`parent`,
 * `subIssues`) decide feature grouping and epic detection. The legacy body-text sections
 * (`## Blocked by`, `## Parent`) remain as a per-issue fallback when an issue has no native edges,
 * and a GitHub **milestone** is still honored as the last grouping fallback; an issue with none of
 * these falls back to merging straight to the base branch.
 *
 * Feature model (Phase 2): an issue's **epic parent** is its feature — all of an epic's children
 * land on one `feat/<epic#>-<slug>` branch and become one PR.
 *
 * Pickup eligibility (mirrors project docs/agents/routing.md): parents/epics (`wayfinder:map` label
 * or any sub-issues) and HITL issues (`wayfinder:grilling` / `wayfinder:prototype`) are DEMOTED to
 * the human queue instead of run — only slices are AFK-eligible.
 *
 * The parsing/decision helpers below are pure and unit-tested; `pick()` wraps them with the GitHub
 * calls.
 */
import { Issue, Picked } from "./types.js";
import { gh, slug } from "./sh.js";

/** Parse the `## Blocked by` section: hard `#N` refs, or free-text we must escalate as ambiguous. */
export function blockersOf(body: string): { refs: number[]; freeText: boolean } {
  const m = body.match(/#+\s*Blocked by\s*([\s\S]*?)(?:\n#+\s|\s*$)/i);
  if (!m || /none/i.test(m[1])) return { refs: [], freeText: false };
  const refs = [
    ...[...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])),
    ...[...m[1].matchAll(/\/issues\/(\d+)/g)].map((x) => Number(x[1])),
  ].filter((v, i, a) => a.indexOf(v) === i);
  return { refs, freeText: refs.length === 0 && m[1].trim().length > 0 };
}

/** Parse the parent/epic issue number from a `## Parent` section (full URL or short `#N`). */
export function parentIssueNumber(body: string): number | null {
  const section = body.match(/##\s*Parent\s*([\s\S]*?)(?:\n##\s|\s*$)/i)?.[1] ?? "";
  const n = section.match(/\/issues\/(\d+)/)?.[1] ?? section.match(/#(\d+)/)?.[1];
  return n ? Number(n) : null;
}

// ── native metadata (GraphQL) with body-text fallback ────────────────────────
/** One issue's native edges, as returned by the batched GraphQL query. */
export type NativeMeta = {
  blockedBy: { number: number; state: string }[];
  parent: { number: number; title: string } | null;
  subIssuesCount: number;
};

/**
 * Blocking decision, native-first: an issue is blocked iff it has any native blocker still OPEN.
 * Only an issue with NO native blockers at all falls back to the body-text `## Blocked by` parse
 * (deprecated — the caller logs a note when the fallback actually finds refs).
 */
export type BlockerResolution =
  | { source: "native"; blocked: boolean; open: number[] }
  | { source: "body"; refs: number[]; freeText: boolean };
export function resolveBlockers(native: NativeMeta["blockedBy"] | null, body: string): BlockerResolution {
  if (native && native.length > 0) {
    const open = native.filter((b) => b.state === "OPEN").map((b) => b.number);
    return { source: "native", blocked: open.length > 0, open };
  }
  return { source: "body", ...blockersOf(body) };
}

/** Parent (epic) resolution: native sub-issue parent wins; else the body `## Parent` parse (whose
 *  title the caller must fetch — `title: null`); else no parent. */
export function resolveParentIssue(
  native: NativeMeta["parent"],
  body: string,
): { num: number; title: string | null } | null {
  if (native) return { num: native.number, title: native.title };
  const n = parentIssueNumber(body);
  return n !== null ? { num: n, title: null } : null;
}

// ── pickup eligibility (mirrors docs/agents/routing.md in the target repo) ───
/**
 * Returns the demotion reason when a `ready-for-agent` issue must be routed to a human instead of
 * run, or null when it's an AFK-eligible slice. Exactly the routing.md rule — nothing more:
 * parents/epics (`wayfinder:map` or any sub-issues) and HITL work (`wayfinder:grilling`,
 * `wayfinder:prototype`) are never run.
 */
export function ineligibleReason(input: { labels: string[]; subIssuesCount: number }): string | null {
  const has = (l: string) => input.labels.includes(l);
  if (has("wayfinder:map"))
    return "⛔ Routed to a human: labeled `wayfinder:map` — a map is a parent/epic, never a slice, so it is not AFK-eligible (docs/agents/routing.md).";
  if (input.subIssuesCount > 0)
    return "⛔ Routed to a human: this is a parent/epic with sub-issues — only slices are AFK-eligible (docs/agents/routing.md).";
  for (const l of ["wayfinder:grilling", "wayfinder:prototype"] as const)
    if (has(l)) return `⛔ Routed to a human: labeled \`${l}\` — human-in-the-loop by definition, not AFK-eligible (docs/agents/routing.md).`;
  return null;
}

/**
 * True when the issue body requests a live verification pass, e.g. "Verify (live): …" or
 * "verify (live," — case-insensitive, any spacing before the paren. Deliberately simple: it does
 * NOT match "verify live" (no paren) or identifiers like `liveVerify(...)`, but it doesn't try to
 * skip code blocks either.
 */
export const liveVerifyRequested = (body: string): boolean => /verify\s*\(live/i.test(body);

/**
 * Fetch native metadata for all candidates in ONE batched GraphQL query (aliases per issue) —
 * no N round trips. A failed query degrades to the body-text fallback for the whole batch.
 */
function fetchNativeMeta(nwo: string, numbers: number[], log: (m: string) => void): Map<number, NativeMeta> {
  const meta = new Map<number, NativeMeta>();
  if (numbers.length === 0) return meta;
  const [owner, name] = nwo.split("/");
  const fields = numbers
    .map((n) => `i${n}: issue(number: ${n}) { number blockedBy(first: 50) { nodes { number state } } parent { number title } subIssues(first: 1) { totalCount } }`)
    .join("\n");
  try {
    const data = JSON.parse(gh(["api", "graphql", "-f", `query=query { repository(owner: "${owner}", name: "${name}") {\n${fields}\n} }`]));
    for (const v of Object.values<any>(data?.data?.repository ?? {})) {
      if (!v?.number) continue;
      meta.set(v.number, {
        blockedBy: (v.blockedBy?.nodes ?? []).map((b: any) => ({ number: b.number, state: b.state })),
        parent: v.parent ? { number: v.parent.number, title: v.parent.title } : null,
        subIssuesCount: v.subIssues?.totalCount ?? 0,
      });
    }
  } catch (e) {
    log(`⚠️  Couldn't fetch native issue metadata (${String((e as Error)?.message ?? e).split("\n")[0]}) — falling back to body-text parsing for this round.`);
  }
  return meta;
}

/** Pure feature derivation — given what we know about an issue, decide its branch + grouping key. */
export function deriveFeature(
  input: { epicNum: number | null; epicTitle: string | null; milestoneTitle: string | null },
  baseBranch: string,
): { featureKey: string | null; branch: string; featureTitle: string | null } {
  if (input.epicNum !== null && input.epicTitle) {
    return {
      featureKey: `epic-${input.epicNum}`,
      branch: `feat/${input.epicNum}-${slug(input.epicTitle)}`,
      featureTitle: input.epicTitle,
    };
  }
  if (input.milestoneTitle) {
    return { featureKey: `ms-${slug(input.milestoneTitle)}`, branch: `feat/${slug(input.milestoneTitle)}`, featureTitle: input.milestoneTitle };
  }
  return { featureKey: null, branch: baseBranch, featureTitle: null };
}

const isClosed = (n: number): boolean =>
  JSON.parse(gh(["issue", "view", String(n), "--json", "state"])).state === "CLOSED";

// Cache parent number → title so we only hit the API once per epic across a whole run.
const parentTitleCache = new Map<number, string>();
function parentTitle(num: number): string | null {
  if (!parentTitleCache.has(num)) {
    try {
      const title: string = JSON.parse(gh(["issue", "view", String(num), "--json", "title"])).title;
      parentTitleCache.set(num, title);
    } catch { return null; } // parent may be deleted
  }
  return parentTitleCache.get(num) ?? null;
}

export type PickDeps = {
  labelReady: string;
  baseBranch: string;
  /** `owner/repo` — needed for the batched native-metadata GraphQL query. */
  nwo: string;
  /** Called for an issue whose `Blocked by` is unparseable — routes it straight to a human. */
  onAmbiguous: (issueNumber: number, reason: string) => void;
  /** Called for an issue that fails the pickup-eligibility contract — swap labels + comment. */
  onDemote: (issueNumber: number, reason: string) => void;
  log?: (m: string) => void;
};

/**
 * Re-queried every round so closing one issue can unblock its dependents in-run. Picks at most
 * `remaining` runnable issues (eligible slices, all blockers closed), routed to their feature.
 */
export function pick(remaining: number, deps: PickDeps): Picked[] {
  const log = deps.log ?? console.log;
  const ready: Issue[] = JSON.parse(
    gh(["issue", "list", "--label", deps.labelReady, "--state", "open", "--json", "number,title,body,milestone,labels", "--limit", "100"]),
  );
  const meta = fetchNativeMeta(deps.nwo, ready.map((i) => i.number), log);
  const out: Picked[] = [];
  for (const i of ready) {
    const body = i.body ?? "";
    const m = meta.get(i.number);

    // Pickup eligibility first: parents/epics + HITL issues get demoted, never run.
    const demote = ineligibleReason({ labels: (i.labels ?? []).map((l) => l.name), subIssuesCount: m?.subIssuesCount ?? 0 });
    if (demote) { deps.onDemote(i.number, demote); continue; }

    // Blocking: native dependencies are authoritative; body text is the deprecated fallback.
    const blockers = resolveBlockers(m?.blockedBy ?? null, body);
    if (blockers.source === "native") {
      if (blockers.blocked) continue; // still blocked — try a later round
    } else {
      if (blockers.freeText) { deps.onAmbiguous(i.number, "Ambiguous `Blocked by` (no `#N` reference). Needs a human to clarify the dependency."); continue; }
      if (blockers.refs.length > 0) log(`#${i.number}: body-text \`Blocked by\` is deprecated — use native issue dependencies (blocked-by) instead.`);
      if (blockers.refs.some((r) => !isClosed(r))) continue; // still blocked — try a later round
    }

    const parent = resolveParentIssue(m?.parent ?? null, body);
    const epicNum = parent?.num ?? null;
    const epicTitle = parent ? parent.title ?? parentTitle(parent.num) : null;
    const { featureKey, branch, featureTitle } = deriveFeature(
      { epicNum, epicTitle, milestoneTitle: i.milestone?.title ?? null },
      deps.baseBranch,
    );
    out.push({
      number: i.number, title: i.title, branch: `afk/issue-${i.number}`,
      feature: branch, featureKey, featureTitle, liveVerify: liveVerifyRequested(body),
    });
    if (out.length >= remaining) break;
  }
  return out;
}
