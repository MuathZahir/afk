/**
 * Failure classification + routing (REDESIGN.md decision #6). Given a failure signal — a merge
 * conflict, an env block, or a Verifier verdict — decide where it goes:
 *
 *   logic     → Fixer loop (the code is wrong; fix + re-verify)
 *   conflict  → Resolver (rebase/resolve before escalating)
 *   flaky     → one automatic re-run (transient infra/timeout)
 *   env       → escalate now (infra the agent can't fix)
 *   ambiguous → escalate now (genuine human judgment needed)
 *
 * This is **deterministic** on purpose: the Verifier emits a structured verdict rich enough to route
 * on without a second LLM call, so routing is cheap, reproducible, and unit-testable. The Haiku
 * classifier from the design is reserved for the one case heuristics can't settle (see
 * `looksAmbiguous`), keeping the host's behavior auditable.
 */
import { Classification, Verdict } from "./types.js";

const FLAKY = /timeout|timed out|econn|socket hang up|ehostunreach|503|502|connection refused|port .*in use|deadlock|flake|flaky|temporarily|try again/i;
const ENV = /docker|compose|out of (disk|memory)|no space left|cannot connect to the docker daemon|image pull|network unreachable|permission denied/i;

/** Classify a Verifier verdict failure into a routing decision. Pure. */
export function classifyVerdict(v: Verdict): Classification {
  const detail = `${v.summary}\n${v.failureDetail ?? ""}\n${v.criteria.filter((c) => !c.pass).map((c) => c.evidence ?? c.criterion).join("\n")}`;
  if (ENV.test(detail)) return { kind: "env", reason: "Verification environment failed to come up." };
  if (FLAKY.test(detail)) return { kind: "flaky", reason: "Transient failure — worth one automatic re-run." };
  const failed = v.criteria.filter((c) => !c.pass);
  if (failed.length > 0) return { kind: "logic", reason: `${failed.length} acceptance criterion/criteria failed.` };
  // verdict.ok was false but no criterion is marked failed → the Verifier itself was unsure.
  return { kind: "ambiguous", reason: "Verifier could not reach a clear verdict." };
}

/** Classify a non-verify failure (merge conflict, thrown error text). Pure. */
export function classifyError(text: string): Classification {
  if (/merge conflict|conflict with|automatic merge failed/i.test(text)) return { kind: "conflict", reason: "Merge conflict on the feature branch." };
  if (ENV.test(text)) return { kind: "env", reason: "Environment/infra failure." };
  if (FLAKY.test(text)) return { kind: "flaky", reason: "Transient failure — worth one automatic re-run." };
  return { kind: "ambiguous", reason: "Unclassified failure — needs a human." };
}

/** Heuristic for whether a verdict's failure is genuinely a judgment call rather than a fixable bug. */
export function looksAmbiguous(v: Verdict): boolean {
  return classifyVerdict(v).kind === "ambiguous";
}
