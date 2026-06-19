/**
 * Shared types for the AFK host engine. Kept dependency-free so both the batch driver (`afk run`)
 * and the daemon (`afk watch`) compile against one vocabulary.
 */

// ── verification env contract (Phase 1) ──────────────────────────────────────
// Every step is overridable per repo; AFK auto-detects sensible defaults and degrades gracefully
// (a repo with no compose file just skips verify with an honest "unverified" note — never a
// false-green). See REDESIGN.md §3.
export type VerifyConfig = {
  /** Master switch. When false (or no compose detected) the feature is marked unverified, not failed. */
  enabled?: boolean;
  /** Bring the stack up from the BRANCH's own compose. `{project}` is substituted with verify_<feat>. */
  up?: string;
  /** Tear down + wipe volumes. Always run, even on failure. */
  down?: string;
  /** Reset/create a fresh isolated DB + run migrations from clean. Optional. */
  dbReset?: string;
  /** Command to start the app under test (when not started by compose). Optional. */
  appBoot?: string;
  /** URL the Verifier points the browser/API at. */
  baseUrl?: string;
  /** Optional seed command; else the Verifier creates data through the app/API. */
  seed?: string;
  /** Path to a test-only secrets file layered into the stack. */
  secrets?: string;
  /** Backend-only feature → skip the browser, API-only verification. */
  backendOnly?: boolean;
  /** Seconds before the whole verify step is abandoned. */
  timeoutSec?: number;
};

export type Config = {
  baseBranch?: string;
  maxParallel?: number;
  maxIssuesPerRun?: number;
  idleTimeoutMin?: number;
  absoluteTimeoutMin?: number;
  issueTimeoutMin?: number; // legacy → absolute cap
  maxFixAttempts?: number;
  model?: string;
  models?: { implement?: string; verify?: string; fix?: string; classify?: string };
  setup?: string;
  labels?: { ready?: string; human?: string };
  verify?: VerifyConfig;
  /** Daemon-only: seconds between queue polls (Phase 3). */
  pollSeconds?: number;
  /** Daemon-only: localhost port for the dashboard (Phase 3/4). */
  dashboardPort?: number;
};

// ── planning ─────────────────────────────────────────────────────────────────
export type Milestone = { title: string } | null;
export type Issue = { number: number; title: string; body: string; milestone: Milestone };

/** A picked issue routed to its feature. `feature` is the branch; `featureKey` groups for verify. */
export type Picked = {
  number: number;
  title: string;
  branch: string;       // afk/issue-<n>
  feature: string;      // feat/<...> or the base branch (legacy)
  featureKey: string | null; // stable id of the owning feature (epic#/slug or milestone), null = base
  featureTitle: string | null;
};

export type Feature = { key: string; title: string; branch: string; merged: number[] };

// ── per-issue/feature outcomes ────────────────────────────────────────────────
export type IssueStatus =
  | "merged" | "rescued" | "blocked" | "timeout" | "conflict" | "no-commits" | "error" | "question" | "stopped";
export type Result = { num: number; title: string; status: IssueStatus; feature: string; media?: number };

// ── verification (Phase 1) ─────────────────────────────────────────────────────
export type CriterionVerdict = { criterion: string; pass: boolean; evidence?: string };
export type Verdict = {
  ok: boolean;
  summary: string;
  criteria: CriterionVerdict[];
  /** Free-text the classifier reads to route a failure. */
  failureDetail?: string;
};

/** How a verify (or merge) failure should be routed. See REDESIGN.md decision #6. */
export type FailureKind = "logic" | "conflict" | "flaky" | "ambiguous" | "env";
export type Classification = { kind: FailureKind; reason: string };
