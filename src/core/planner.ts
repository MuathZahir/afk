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
 * or any sub-issues) and HITL issues (`wayfinder:grilling`) are DEMOTED to the human queue instead
 * of run — only slices are AFK-eligible. `wayfinder:prototype` is eligible once a human applied the
 * ready label, but the label alone forces the draft + `verify:live-pending` hold; a
 * `wayfinder:research` candidate runs in research mode (findings comment, no PR).
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
 * parents/epics (`wayfinder:map` or any sub-issues) and HITL work (`wayfinder:grilling`) are never
 * run. `wayfinder:prototype` is NOT demoted — prototype building is eligible once a human applied
 * the ready label; `requiresLiveVerify` is its safety net (draft + `verify:live-pending` hold).
 */
export function ineligibleReason(input: { labels: string[]; subIssuesCount: number }): string | null {
  const has = (l: string) => input.labels.includes(l);
  if (has("wayfinder:map"))
    return "⛔ Routed to a human: labeled `wayfinder:map` — a map is a parent/epic, never a slice, so it is not AFK-eligible (docs/agents/routing.md).";
  if (input.subIssuesCount > 0)
    return "⛔ Routed to a human: this is a parent/epic with sub-issues — only slices are AFK-eligible (docs/agents/routing.md).";
  if (has("wayfinder:grilling"))
    return "⛔ Routed to a human: labeled `wayfinder:grilling` — human-in-the-loop by definition, not AFK-eligible (docs/agents/routing.md).";
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
 * The full live-verification decision: an explicit `Verify (live)` body request OR the
 * `wayfinder:prototype` label — the label alone forces the draft + `verify:live-pending` hold, so
 * a blind-built prototype is never presented as ready-for-review (routing.md, "Prototype tickets").
 */
export function requiresLiveVerify(body: string, labels: string[]): boolean {
  return liveVerifyRequested(body) || labels.includes("wayfinder:prototype");
}

/** A `wayfinder:research` candidate runs the research lane (findings comment + close, no PR —
 *  routing.md, "`wayfinder:research` tickets"); everything else is a normal implement. */
export function issueMode(labels: string[]): "implement" | "research" {
  return labels.includes("wayfinder:research") ? "research" : "implement";
}

/**
 * Fetch native metadata for all candidates in ONE batched GraphQL query (aliases per issue) —
 * no N round trips. `gh api graphql` exits non-zero whenever the response carries an `errors`
 * array — even with partial `data` (e.g. ONE deleted/transferred issue alias) — so on failure we
 * recover the response from the error's `.stdout` and use whatever parsed: only issues MISSING
 * from it fall back to body text. A fully unparseable response degrades to the body-text fallback
 * for the whole batch.
 */
function fetchNativeMeta(nwo: string, numbers: number[], log: (m: string) => void): Map<number, NativeMeta> {
  const meta = new Map<number, NativeMeta>();
  if (numbers.length === 0) return meta;
  const [owner, name] = nwo.split("/");
  const fields = numbers
    .map((n) => `i${n}: issue(number: ${n}) { number blockedBy(first: 50) { nodes { number state } } parent { number title repository { nameWithOwner } } subIssues(first: 1) { totalCount } }`)
    .join("\n");
  let data: any = null;
  try {
    data = JSON.parse(gh(["api", "graphql", "-f", `query=query { repository(owner: "${owner}", name: "${name}") {\n${fields}\n} }`]));
  } catch (e) {
    const line = String((e as Error)?.message ?? e).split("\n")[0];
    // execFileSync errors carry the process's stdout (utf8 per `gh()`) — recover the partial data.
    try { data = JSON.parse((e as { stdout?: string })?.stdout ?? ""); } catch { data = null; }
    if (data?.data?.repository) {
      log(`⚠️  Native issue metadata came back partial (${line}) — issues missing from the response fall back to body-text parsing.`);
    } else {
      data = null;
      log(`⚠️  Couldn't fetch native issue metadata (${line}) — falling back to body-text parsing for this round.`);
    }
  }
  for (const v of Object.values<any>(data?.data?.repository ?? {})) {
    if (!v?.number) continue;
    // A native parent can live in ANOTHER repo — downstream featureChildren/parentTitle would query
    // its number in THIS repo, so treat a cross-repo parent as no native parent (body fallback).
    let parent = v.parent ? { number: v.parent.number, title: v.parent.title } : null;
    const parentRepo: string | undefined = v.parent?.repository?.nameWithOwner;
    if (parent && parentRepo && parentRepo.toLowerCase() !== nwo.toLowerCase()) {
      log(`#${v.number}: native parent #${parent.number} lives in ${parentRepo}, not ${nwo} — ignoring it (body-text fallback).`);
      parent = null;
    }
    meta.set(v.number, {
      blockedBy: (v.blockedBy?.nodes ?? []).map((b: any) => ({ number: b.number, state: b.state })),
      parent,
      subIssuesCount: v.subIssues?.totalCount ?? 0,
    });
  }
  return meta;
}

// ── per-effort base branches ─────────────────────────────────────────────────
/** Parse a `Base: <branch>` declaration: its own line, case-insensitive, optional backticks around
 *  the branch. First match wins. Returns null when the body declares no base. */
export function parseBaseLine(body: string): string | null {
  return body.match(/^base:\s*`?([\w./-]+)`?\s*$/im)?.[1] ?? null;
}

/**
 * Pure base-precedence resolution (frozen contract):
 *  1. Grouped issue (has epic parent): the EPIC's `Base:` line governs; the child's own `Base:`
 *     line is IGNORED — reported back as `ignoredOwnBase` (when it differs) so the caller warns.
 *  2. Loose issue: its own `Base:` line.
 *  3. Fallback: the config `baseBranch`.
 */
export function resolveBase(input: {
  /** The issue's own parsed `Base:` line (null = none). */
  ownBase: string | null;
  /** True when the issue has an epic parent (grouped). */
  hasEpic: boolean;
  /** The epic's parsed `Base:` line (null = epic declares none / body unavailable). Ignored when `!hasEpic`. */
  epicBase: string | null;
  configBase: string;
}): { base: string; ignoredOwnBase: string | null } {
  if (input.hasEpic) {
    const base = input.epicBase ?? input.configBase;
    return { base, ignoredOwnBase: input.ownBase !== null && input.ownBase !== base ? input.ownBase : null };
  }
  return { base: input.ownBase ?? input.configBase, ignoredOwnBase: null };
}

/** Pure feature derivation — given what we know about an issue, decide its branch + grouping key.
 *  `base` is the issue's RESOLVED base branch (see `resolveBase`) — a loose issue's feature IS its base. */
export function deriveFeature(
  input: { epicNum: number | null; epicTitle: string | null; milestoneTitle: string | null },
  base: string,
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
  return { featureKey: null, branch: base, featureTitle: null };
}

const isClosed = (n: number): boolean =>
  JSON.parse(gh(["issue", "view", String(n), "--json", "state"])).state === "CLOSED";

// Cache parent number → {title, body} so we only hit the API once per epic across a whole run —
// the title names the feature branch, the body carries the epic's `Base:` line.
const parentInfoCache = new Map<number, { title: string; body: string }>();
function parentInfo(num: number): { title: string; body: string } | null {
  if (!parentInfoCache.has(num)) {
    try {
      const v = JSON.parse(gh(["issue", "view", String(num), "--json", "title,body"]));
      parentInfoCache.set(num, { title: v.title, body: v.body ?? "" });
    } catch { return null; } // parent may be deleted — not cached, so a transient failure retries
  }
  return parentInfoCache.get(num) ?? null;
}

export type PickDeps = {
  labelReady: string;
  /** The CONFIG default base — only the precedence fallback; issues/epics may override via `Base:`. */
  baseBranch: string;
  /** `owner/repo` — needed for the batched native-metadata GraphQL query. */
  nwo: string;
  /** Called for an issue whose `Blocked by` is unparseable — routes it straight to a human. */
  onAmbiguous: (issueNumber: number, reason: string) => void;
  /** Called for an issue that fails the pickup-eligibility contract — swap labels + comment. */
  onDemote: (issueNumber: number, reason: string) => void;
  /** Issues being worked on RIGHT NOW (daemon pool) — skipped entirely, so an issue that becomes
   *  ineligible mid-implement isn't demoted under its running worker. `afk run` needn't pass it. */
  inFlight?: Set<number>;
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
  const byNumber = new Map(ready.map((i) => [i.number, i]));

  // Memoized per-candidate parent + base resolution — the cross-base blocker warning needs a
  // BLOCKER candidate's base too, and epic bodies are fetched once per epic (`parentInfo` cache).
  type ResolvedIssue = {
    epicNum: number | null; epicTitle: string | null;
    base: string; baseSource: string; ignoredOwnBase: string | null;
  };
  const resolvedCache = new Map<number, ResolvedIssue>();
  const resolveFor = (i: Issue): ResolvedIssue => {
    const hit = resolvedCache.get(i.number);
    if (hit) return hit;
    const body = i.body ?? "";
    const parent = resolveParentIssue(meta.get(i.number)?.parent ?? null, body);
    const info = parent ? parentInfo(parent.num) : null;
    if (parent && !info) log(`⚠️ #${i.number}: couldn't fetch epic #${parent.num}'s body — its \`Base:\` line (if any) is invisible, falling back.`);
    const epicTitle = parent ? parent.title ?? info?.title ?? null : null;
    const ownBase = parseBaseLine(body);
    const epicBase = info ? parseBaseLine(info.body) : null;
    const { base, ignoredOwnBase } = resolveBase({ ownBase, hasEpic: parent !== null, epicBase, configBase: deps.baseBranch });
    const baseSource =
      parent !== null && epicBase !== null ? `the \`Base:\` line in epic #${parent.num}`
      : parent === null && ownBase !== null ? `the \`Base:\` line in issue #${i.number}`
      : "`baseBranch` in afk.config.json";
    const r: ResolvedIssue = { epicNum: parent?.num ?? null, epicTitle, base, baseSource, ignoredOwnBase };
    resolvedCache.set(i.number, r);
    return r;
  };

  const out: Picked[] = [];
  for (const i of ready) {
    if (deps.inFlight?.has(i.number)) continue; // its worker is running — no demote, no re-pick
    const body = i.body ?? "";
    const m = meta.get(i.number);
    const labels = (i.labels ?? []).map((l) => l.name);

    // Pickup eligibility first: parents/epics + HITL issues get demoted, never run.
    const demote = ineligibleReason({ labels, subIssuesCount: m?.subIssuesCount ?? 0 });
    if (demote) { deps.onDemote(i.number, demote); continue; }

    const r = resolveFor(i);

    // Blocking: native dependencies are authoritative; body text is the deprecated fallback.
    const blockers = resolveBlockers(m?.blockedBy ?? null, body);
    if (blockers.source === "native") {
      // Cross-base dependency heads-up (cheap, best-effort): a blocker that's also among this
      // round's candidates but resolves to a DIFFERENT base gates on issue-closed, not code-merged
      // — its code will never be on this issue's base.
      const cross = (m?.blockedBy ?? [])
        .map((b) => byNumber.get(b.number))
        .filter((c): c is Issue => c !== undefined)
        .filter((c) => resolveFor(c).base !== r.base);
      if (cross.length > 0)
        log(`⚠️ #${i.number} (base \`${r.base}\`) is blocked by ${cross.map((c) => `#${c.number} (base \`${resolveFor(c).base}\`)`).join(", ")} on a DIFFERENT base — the dependency gates on issue-closed, not code-merged.`);
      if (blockers.blocked) continue; // still blocked — try a later round
    } else {
      if (blockers.freeText) { deps.onAmbiguous(i.number, "Ambiguous `Blocked by` (no `#N` reference). Needs a human to clarify the dependency."); continue; }
      if (blockers.refs.length > 0) log(`#${i.number}: body-text \`Blocked by\` is deprecated — use native issue dependencies (blocked-by) instead.`);
      if (blockers.refs.some((n) => !isClosed(n))) continue; // still blocked — try a later round
    }

    if (r.ignoredOwnBase)
      log(`⚠️ #${i.number}: its own \`Base: ${r.ignoredOwnBase}\` line is ignored — the epic's resolved base \`${r.base}\` governs grouped issues.`);

    const { featureKey, branch, featureTitle } = deriveFeature(
      { epicNum: r.epicNum, epicTitle: r.epicTitle, milestoneTitle: i.milestone?.title ?? null },
      r.base,
    );
    out.push({
      number: i.number, title: i.title, branch: `afk/issue-${i.number}`,
      feature: branch, featureKey, featureTitle, base: r.base, baseSource: r.baseSource,
      liveVerify: requiresLiveVerify(body, labels),
      mode: issueMode(labels),
    });
    if (out.length >= remaining) break;
  }
  return out;
}
