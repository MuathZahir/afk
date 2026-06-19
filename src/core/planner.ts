/**
 * Deterministic planner: parse issue bodies and decide which `ready-for-agent` issues can run now
 * and which feature each belongs to.
 *
 * Feature model (Phase 2): an issue's **epic parent** (`## Parent #N`) is its feature — all of an
 * epic's children land on one `feat/<epic#>-<slug>` branch and become one PR. A GitHub **milestone**
 * is still honored as a legacy fallback so existing repos keep working; an issue with neither falls
 * back to merging straight to the base branch.
 *
 * The parsing helpers below are pure and unit-tested; `pick()` wraps them with the GitHub calls.
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
  /** Called for an issue whose `Blocked by` is unparseable — routes it straight to a human. */
  onAmbiguous: (issueNumber: number, reason: string) => void;
};

/**
 * Re-queried every round so closing one issue can unblock its dependents in-run. Picks at most
 * `remaining` runnable issues (all blockers closed, dependency-safe), routed to their feature.
 */
export function pick(remaining: number, deps: PickDeps): Picked[] {
  const ready: Issue[] = JSON.parse(
    gh(["issue", "list", "--label", deps.labelReady, "--state", "open", "--json", "number,title,body,milestone", "--limit", "100"]),
  );
  const out: Picked[] = [];
  for (const i of ready) {
    const { refs, freeText } = blockersOf(i.body ?? "");
    if (freeText) { deps.onAmbiguous(i.number, "Ambiguous `Blocked by` (no `#N` reference). Needs a human to clarify the dependency."); continue; }
    if (refs.some((r) => !isClosed(r))) continue; // still blocked — try a later round

    const epicNum = parentIssueNumber(i.body ?? "");
    const epicTitle = epicNum !== null ? parentTitle(epicNum) : null;
    const { featureKey, branch, featureTitle } = deriveFeature(
      { epicNum, epicTitle, milestoneTitle: i.milestone?.title ?? null },
      deps.baseBranch,
    );
    out.push({ number: i.number, title: i.title, branch: `afk/issue-${i.number}`, feature: branch, featureKey, featureTitle });
    if (out.length >= remaining) break;
  }
  return out;
}
