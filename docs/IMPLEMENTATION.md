# AFK v2 — Implementation log

Companion to [`REDESIGN.md`](./REDESIGN.md) (the full target architecture). This file records what
has actually been **built** so far, and what is intentionally still on the roadmap.

---

## Shipped: Phase 0 — robustness quick wins

Phase 0 was chosen first because the design doc flags it as "biggest pain relief for least code, **no
architecture change**." Everything here applies to the existing `afk run` engine and is verifiable by
the typechecker — no live Docker/app environment required to build it safely. It directly attacks the
three pains you named: **timeouts, over-eager `ready-for-human`, and lost time on stuck work.**

### 1. Idle-based timeouts + absolute backstop (was: a single hard wall-clock)

**Before:** one `setTimeout` aborted every worker at `issueTimeoutMin` (30m) regardless of whether it
was productively working or genuinely stuck — the exact "tasks take too long / get killed mid-work"
failure.

**Now:** the worker is killed on **inactivity** (`idleTimeoutSeconds`, sandcastle's native idle
detection) — the real signal that an agent is stuck or looping — with a generous **absolute cap** as a
final backstop so a productive long task is never guillotined.

- `idleTimeoutMin` (default **10**) → passed to `sandbox.run({ idleTimeoutSeconds })`.
- `absoluteTimeoutMin` (default **90**) → the `AbortController` backstop.
- Legacy `issueTimeoutMin` is still honored as the absolute cap, so existing configs keep working.
- The escalation message now distinguishes "hit the Nm absolute cap" from "stalled (idle > Nm)".

### 2. Bounded self-correction loop (was: any failure escalates immediately)

**Before:** if a worker got stuck on its own code, it wrote `.afk/blocked.json`, the host escalated to
`ready-for-human` immediately, and the work was skipped — even when one more attempt would have fixed it.

**Now:** the implementer runs inside a bounded retry loop (`maxFixAttempts`, default **1**). When it
self-declares stuck on its **own code** (or produces nothing at all), the host **re-runs it in the same
sandbox** — worktree and partial work preserved — with the previous blocker injected as context (the new
`{{RETRY_NOTE}}` prompt slot). Only after the retries are exhausted does it escalate.

Crucially, this is **not** a blanket retry:
- **Environment** blocks are tagged `"category":"env"` in `blocked.json` and **skip the retry** — agents
  shouldn't grind on infra they can't fix; that routes straight to a human (correct, per the existing
  bail philosophy).
- Thrown errors and timeouts do **not** retry (a hung/aborted run won't benefit from an immediate re-run).

This is the deterministic, no-new-infrastructure precursor to the full type-aware routing in the design.

### 3. Per-role model config (groundwork)

`afk.config.json` now carries a `models: { implement, verify, fix, classify }` map (subscription
rate-window friendly — Opus for hard reasoning, lighter models for light roles). The implementer reads
`models.implement` (falling back to the single `model` knob). `verify`/`fix`/`classify` are recorded for
the later phases that introduce those roles; **only `implement` is wired today.**

---

## Files changed

| File | Change |
|------|--------|
| `src/run.ts` | Idle + absolute timeout model; bounded self-correction loop around `sandbox.run`; per-role `models.implement`; clearer escalation messages. |
| `.sandcastle/implement-prompt.md` | New `{{RETRY_NOTE}}` slot; `blocked.json` now carries `"category": "env"｜"code"` so the host knows what to retry vs. escalate. |
| `.sandcastle/afk.config.json`, `.sandcastle/afk.config.example.json` | New keys: `idleTimeoutMin`, `absoluteTimeoutMin`, `maxFixAttempts`, `models`. |
| `src/init.mjs` | Generates the new config keys for fresh projects. |
| `README.md` | Config table + "failures self-correct once, then route to humans" updated to match. |
| `docs/REDESIGN.md`, `docs/IMPLEMENTATION.md` | The design + this log. |

## How it was verified

- `npm run typecheck` (`tsc --noEmit`, `strict: true`) passes.
- Relied only on sandcastle APIs confirmed present in `node_modules/@ai-hero/sandcastle/dist/index.d.ts`:
  `SandboxRunOptions.idleTimeoutSeconds`, and the documented contract that a `Sandbox` handle "remains
  usable after abort — call `.run()` again" (the basis for re-running in the same sandbox).
- **Not** exercised against a live repo here (that needs Docker + a target repo + the OAuth token).
  Phase 0 changes are deliberately confined to control-flow that the typechecker covers and that does
  not alter the proven merge/rescue/escalate paths.

---

## Not done yet (and why) — the roadmap continues in `REDESIGN.md`

These need a live Docker + running-app environment to build and validate safely, so they are **not**
implemented blind. Build order from the design:

- **Phase 1 — Verifier + env contract.** Dedicated Verifier agent (agent-browser for UI + direct API
  calls), per-feature verification, `docker compose -p verify_<feature>` from the branch with a fresh
  isolated DB, evidence posted to the PR. *(The implementer keeps its optional screenshot step until the
  Verifier exists — dropping it now would remove all visual proof with nothing to replace it.)*
- **Phase 2 — epic + sub-issue feature model** (replace milestone grouping).
- **Phase 3 — `afk watch` daemon** (continuous lifecycle manager + state store + rate-aware backoff).
- **Phase 4 — local dashboard** (monitor + merge/retry/answer actions over the daemon's state/stream).

Type-aware failure routing (conflict→resolver, flaky→re-run, ambiguous→escalate-now) lands with Phase 1,
where the Verifier creates failures rich enough to route on.
