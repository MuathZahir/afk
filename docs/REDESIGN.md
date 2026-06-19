# AFK v2 — Design

> Output of a `/grill-me` design session. This is the target architecture for evolving AFK
> from a batch issue-drainer into a continuous, self-correcting, observable "agent factory."
> Decisions below are settled; second-order details carry sensible defaults and are flagged.

## North star

The developer's loop becomes: **grill → PRD → issues → forget.** From the moment an issue is
`ready-for-agent`, AFK carries it autonomously through implement → verify → fix → **a green,
evidence-backed PR**, with no further human input. The human only (a) reviews/merges PRs as they
arrive, (b) handles the rare genuine escalation, (c) answers an occasional clarifying question —
all from one local dashboard. Design/PRD/grilling stays in Claude Code (the creative loop); the
dashboard is the monitoring + merge surface for the autonomous part.

---

## Settled decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Execution model** | Long-running local **`afk watch` daemon** (lifecycle manager, not just a queue-drainer). Evolves the current engine; doesn't rebuild it. |
| 2 | **Agent topology** | **Implement → Verify → type-aware Fix-loop.** Specialized roles, self-correction before escalation. |
| 3 | **Verify granularity** | **Per-feature, on completion** (when all of an epic's child issues have landed on the feature branch). |
| 4 | **Verify infra** | **Always bring the stack up from the branch's own compose**, layer-cache-accelerated, **fresh isolated DB per feature**, `down -v` after. Never touches the dev's working DB. |
| 5 | **Reuse layer** | Reuse happens at **Docker's layer cache** (correct even when services change), not a pinned warm stack. |
| 6 | **Failure handling** | **Classify, then route:** logic→Fixer loop; conflict→resolver; flaky→one re-run; ambiguous→escalate immediately. Escalate only after the right path is exhausted, with full evidence. |
| 7 | **Test artifacts** | **Ephemeral verification + rich evidence** (per-criterion verdict, screenshots, short video, API traces on the PR). Durable coverage comes from the implementer's TDD tests. No committed e2e specs. |
| 8 | **Feature model** | **Epic parent-issue + sub-issues** replaces milestones. Branch `feat/<epic#>-<slug>`, one PR per epic, strict `Blocked by #N` dependencies. |
| 9 | **Dashboard scope** | **Monitor + key actions** (merge PR, retry escalation, answer a question, pause/resume). |
| 10 | **Timeout model** | **Idle-based** (kill on inactivity via the live stream) **+ absolute backstop** (~90m). No more guillotining productive long tasks. |
| 11 | **Models per role** | **Per-role:** Opus (Implementer, Fixer), Sonnet (Verifier), Haiku (classifier/router). Tuned for subscription rate-windows, not $. All overridable. |

### Confirmed assumptions (not separately grilled)
- Verifier uses **agent-browser** (UI, over CDP) + **direct API calls** (curl/httpie). **No clawflow** (not ready for real use).
- Implementer **no longer does screenshots** — the Verifier owns all visual proof. (Removes the #1 budget-waste.)
- **Fully autonomous issue → PR.** No plan-approval checkpoint by default; the human enters only at PR review or escalation.
- Rate-limit → daemon **backs off and auto-resumes** when the window resets (no re-invocation).
- **One repo per daemon instance** for v1; multi-repo is a later upgrade.

---

## Target workflow, end to end

```
DEVELOPER (Claude Code)                 AFK DAEMON (local, always on)           AGENTS (per task)
─────────────────────────              ─────────────────────────────          ──────────────────
/grill-with-docs                        poll queue every ~60s
/to-prd  → epic parent issue            discover epics + sub-issue graph
/to-issues → child slices               ┌─ per ready child issue ────────────▶ IMPLEMENTER (Opus)
  (ready-for-agent)                      │   isolated sandbox, TDD, commit       isolated docker sandbox
        │                                │   (no screenshots)                    idle-timeout
   …forget…                              │   rebase on feature branch, merge
                                         │
   monitor dashboard ◀── live stream ────┤   when epic's children all landed:
   merge PRs ◀────────── PR ready ───────┤   ┌─ VERIFY ──────────────────────▶ VERIFIER (Sonnet)
                                         │   │  compose -p verify_<feat> up      from branch, fresh DB
                                         │   │  from branch (cache-fast)         agent-browser (UI)
                                         │   │  fresh DB + migrate + seed         + direct API calls
                                         │   │  exercise every acceptance         structured verdict
                                         │   │  criterion across all children    + evidence
                                         │   │  down -v
                                         │   └─ verdict ──┐
                                         │                ├─ green → PR draft→ready + evidence
                                         │                └─ fail  → classify → route:
                                         │                            logic   → FIXER (Opus) loop ↺ re-verify
                                         │                            conflict → RESOLVER (Opus)
                                         │                            flaky    → one auto re-run
                                         │                            ambiguous→ escalate (card + evidence)
   answer question / re-queue ◀── card ──┘
```

---

## Components

### 1. The daemon (`afk watch`)
- Polls GitHub for `ready-for-agent` issues on an interval (webhook trigger is a later upgrade).
- **Lifecycle manager**: drives each issue/feature through the full state machine; survives restarts by
  reconciling its state store against GitHub + local branches.
- **State store** (SQLite or append-only JSON event log): epics, features, issues, runs, agents, PRs,
  escalations, token usage. This is both the daemon's memory and the dashboard's data source.
- **Concurrency**: bounded implementer pool (default 2–3) + rate-window-aware backoff/auto-resume.
- **Serves the dashboard** locally (e.g. `localhost:7777`) with SSE for live events.
- Existing safety nets kept: serialized host-side git writes, uncommitted-work rescue, stale-worktree/
  container reaping at startup.

### 2. Agent roles
| Role | Model | Sandbox | Job |
|------|-------|---------|-----|
| **Implementer** | Opus | isolated docker (per issue) | TDD a thin vertical slice, unit/integration tests at the seam, commit. No screenshots. |
| **Verifier** | Sonnet | compose-from-branch (per feature) | Bring up the branch's stack + fresh DB, exercise every acceptance criterion across the epic's children via agent-browser (UI) + direct API calls; emit a structured per-criterion verdict + evidence. |
| **Fixer** | Opus | the feature branch | Given the verdict + diff + logs, `/diagnose` and fix; re-verify. Bounded attempts. Fresh context (failures span multiple issues). |
| **Resolver** | Opus | the feature branch | Rebase/resolve a merge conflict with full conflict context before escalating. |
| **Classifier / router** | Haiku | none | Cheap calls: failure triage, dependency parsing, "is this genuinely ambiguous → escalate now." |

### 3. Verification environment — the project contract (`afk.config`)
AFK ships defaults and auto-detects; every step is overridable per repo:
- `verify.up` / `verify.down` — default `docker compose -p verify_<feat> up -d --build` / `down -v`.
- `verify.dbReset` — fresh uniquely-named DB + run the project's migrate command from clean (template-DB clone if available).
- `verify.appBoot` + `verify.baseUrl` — how to start the app under test + its URL.
- `verify.seed` — optional; else the Verifier creates needed data through the app/API (more realistic e2e).
- `verify.secrets` — `.env.verify` for test-only secrets.
- Backend-only feature → skip the browser, API-only verification.

### 4. Dashboard (local web UI, served by the daemon)
- **Views**: daemon status; running agents (role, target, live activity, token spend, elapsed/idle);
  epic→feature→issue tree with per-node state; PRs (draft/ready/merged) with verification evidence;
  needs-human queue.
- **Actions**: merge a ready PR; retry/re-queue an escalation; answer an agent's clarifying question;
  pause/resume the daemon.
- **Human-in-the-loop as cards**: a clarifying question or escalation surfaces as an actionable card
  (optionally a push notification); the daemon pauses that item until answered — the pressure-release
  valve so agents *ask* instead of guessing or escalating.
- Keep it simple: an embedded HTTP server + a lightweight SPA (use the `frontend-design` skill).

---

## How this kills each known pain

| Pain (today) | Fix (v2) |
|--------------|----------|
| Tasks time out mid-work | Idle-based timeout + backstop; smaller implement tasks; Verifier offloads the e2e grind. |
| Over-eager `ready-for-human` | Type-aware fix loop self-corrects first; only genuine human-judgment cases escalate, with evidence. |
| Merge conflicts escalate | Rebase issue branch on the feature branch before merge; dependency-ordered slices; dedicated Resolver attempt. |
| Milestone grouping brittle/manual | Native epic + sub-issues; no manual milestone juggling; strict dependency refs. |
| No real verification / no visibility | Dedicated Verifier with real infra + evidence on the PR; live dashboard. |
| Recreating infra is slow | Per-feature (not per-issue) frequency + Docker layer cache + template DB. |
| Agent burns budget chasing screenshots | Implementer no longer screenshots; the Verifier owns visual proof on its own schedule. |

---

## Phased build order (each phase ships value on its own)

- **Phase 0 — robustness quick wins** (no architecture change, applies to today's `afk run`):
  idle-timeout, the fix loop (via `RunResult.resume`/`fork`), failure classification, rebase-before-merge,
  drop the implementer's screenshot step. *Biggest pain relief for least code.*
- **Phase 1 — Verifier + env contract**: the dedicated Verifier agent, per-feature verification, the
  compose-from-branch isolated env, evidence posted to the PR.
- **Phase 2 — epic/sub-issue feature model**: replace milestone grouping; strict dependency graph.
- **Phase 3 — daemon**: `afk watch` lifecycle manager + state store + rate-aware backoff + restart recovery.
- **Phase 4 — dashboard**: local web UI over the daemon's state/stream + the key actions.

---

## Risks / devil's-advocate (pressure-test before building)

- **Is the daemon worth it over cron + a report?** A daemon is more to operate (a process to keep alive,
  state to reconcile). Justified only because the dashboard + continuous fix-loop genuinely need a
  long-lived process. If Phases 0–2 already feel "hands-off enough," Phases 3–4 can wait.
- **Per-feature verification = slow feedback.** A bug introduced early surfaces only at feature
  completion, and the Fixer works a larger surface. Mitigation: keep features small (they already are —
  vertical slices); revisit a per-issue smoke (the "tiered" option) only if this bites.
- **Compose-from-branch assumes a dockerized dev stack.** Repos without one fall back to the
  project-defined `verify.*` contract; the auto-detect must degrade gracefully (API-only, or skip verify
  with a clear "unverified — needs manual test" note rather than a false-green).
- **Dashboard scope creep.** "Monitor + key actions" must not drift into re-implementing GitHub. Every
  action must earn its place against "could you just do this in GitHub?"
- **Verifier seed/auth realism.** Creating data through the app is more realistic but slower and can fail
  for features that need pre-existing state; the `verify.seed` hook is the escape valve.

---

## Open second-order items (not blocking; pick any to grill further)
- Exact state-store choice (SQLite vs event-log JSON) and dashboard tech stack.
- Daemon concurrency tuning + how aggressively to parallelize independent slices within an epic.
- Clarifying-question protocol (how an agent signals it needs input vs. escalating).
- Multi-repo support shape (one daemon, many repos vs. one daemon per repo).
- Webhook-based triggering to replace polling.
