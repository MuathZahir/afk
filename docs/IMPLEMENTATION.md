# AFK v2 — Implementation log

Companion to [`REDESIGN.md`](./REDESIGN.md) (the full target architecture). This file records what
has actually been **built**, and what is intentionally still on the roadmap.

**Status: Phases 0–4 shipped.** The batch engine (`afk run`) and the continuous daemon + dashboard
(`afk watch`) both drive one shared, unit-tested host engine. The deterministic core (planning,
routing, state) is covered by tests that run with no Docker/GitHub/LLM; the live agent + Docker paths
are typecheck-clean and carefully designed against confirmed sandcastle APIs, and degrade gracefully
where a live environment is required (see "What still needs live validation").

---

## Architecture

A single shared **`Engine`** (`src/core/engine.ts`) owns all the deterministic host orchestration and
every proven safety net (serialized git writes, uncommitted-work rescue, stale worktree/container
reaping). Two thin drivers wrap it:

- **`afk run`** (`src/run.ts`) — drain the queue once, then exit.
- **`afk watch`** (`src/watch.ts` → `core/daemon.ts` + `core/server.ts`) — a continuous lifecycle
  manager + local dashboard.

The engine reports side effects two ways: a human `log()` line and a structured `emit()` event. The
daemon wires `emit` to an append-only event-log **state store** (`core/state.ts`), which is both its
restart memory and the dashboard's data source. This is REDESIGN.md decision #1 — *evolve the engine,
don't rebuild it* — made concrete.

---

## Shipped: Phase 0 — robustness quick wins

Applies to the existing per-issue engine; no architecture change.

- **Idle-based timeouts + absolute backstop.** Killed on inactivity (`idleTimeoutMin`, sandcastle's
  native idle detection — the real "stuck" signal), with a generous `absoluteTimeoutMin` backstop so a
  productive long task is never guillotined. Legacy `issueTimeoutMin` maps to the absolute cap.
- **Bounded self-correction.** When the implementer self-declares stuck on its **own** code (or
  produces nothing), the host re-runs it in the same sandbox with the prior blocker injected
  (`{{RETRY_NOTE}}`), up to `maxFixAttempts`. Environment blocks (`"category":"env"`) and thrown
  errors skip the retry and route to a human.
- **Per-role model config groundwork** (`models: { implement, verify, fix, classify }`).

## Shipped: Phase 1 — Verifier + env contract + type-aware failure routing

- **Verifier** (`core/verify.ts`, `.sandcastle/verify-prompt.md`) — a Sonnet agent that runs on the
  completed feature branch with the host Docker socket bind-mounted. It owns `compose up → fresh DB →
  exercise every acceptance criterion (agent-browser for UI + direct API calls) → down -v` itself and
  writes a structured `.afk/verdict.json` (per-criterion pass/fail + evidence). The host stays
  deterministic: it decides *when* to verify, injects the contract + criteria, reads the verdict,
  uploads the screenshots, and posts a per-criterion table to the PR.
- **Env contract** (`verify.*` in config) — `up`/`down`/`dbReset`/`appBoot`/`baseUrl`/`seed`/
  `secrets`/`backendOnly`/`timeoutSec`, all auto-detected and overridable. **Graceful degradation:**
  no compose stack, a Windows host, or a stack that won't boot ⇒ the PR is marked *"unverified — test
  manually,"* never a false green (REDESIGN.md risk §).
- **Type-aware routing** (`core/classify.ts`, deterministic + unit-tested) — a failing verdict or a
  merge error is classified and routed: `logic → Fixer loop` (`.sandcastle/fix-prompt.md`),
  `conflict → Resolver` (`.sandcastle/resolve-prompt.md`), `flaky → one auto re-verify`,
  `env｜ambiguous → escalate with evidence`. The Verifier emits enough structure to route on without a
  second LLM call.
- **Implementer no longer screenshots** — the Verifier owns all visual proof (removes the #1 budget
  waste). `implement-prompt.md` updated accordingly.

## Shipped: Phase 2 — epic / sub-issue feature model

- An issue's **epic parent** (`## Parent #N`, already written by `/to-issues`) is its feature.
  Children land on `feat/<epic#>-<slug>`, one PR per epic, verified before the PR goes ready
  (`core/planner.ts → deriveFeature`, unit-tested). **No manual milestone juggling** — the linkage
  `to-issues` already creates *is* the grouping. GitHub milestones remain a legacy fallback;
  neither ⇒ merge to the base branch.
- Feature completion is detected from GitHub (no open ready children of the epic remain) to trigger
  verify + flip the PR from draft to ready.

## Shipped: Phase 3 — `afk watch` daemon

`core/daemon.ts` — a long-running lifecycle manager over the shared Engine:

- **Poll loop** (`pollSeconds`) tops up a **bounded worker pool** (`maxParallel`); as each issue
  lands it checks epic completeness and launches verify → Fixer-loop → PR.
- **Rate-aware backoff/auto-resume** — a rate-limit error parks the loop and self-restores when the
  window passes; no re-invocation.
- **Restart recovery** — replays the event log and **reconciles against GitHub**: every open `feat/*`
  draft PR is rebuilt into an in-flight feature (children parsed from its `Closes #N` lines), and a
  verify interrupted by a crash is re-run.
- **Control surface** — `pause/resume`, `retry` (re-queue an escalation), `merge` (squash-merge a
  ready PR), `answer` (record a reply to an agent's question).

## Shipped: Phase 4 — local dashboard

`core/server.ts` + `core/dashboard.ts` — a dependency-free `node:http` server the daemon hosts on
`localhost:<dashboardPort>`:

- Serves a single-file SPA, a JSON snapshot (`/api/state`), a live **SSE** stream (`/api/stream`),
  and the action endpoints. The server's `reduce()` is the single source of truth — the client
  re-pulls the snapshot on each event instead of re-implementing the fold.
- **Views:** daemon status + totals, epic→issue tree with per-node state, running agents (role,
  target, tokens, live pulse), the needs-human queue, and clarifying questions.
- **Actions:** one-click merge a ready PR, re-queue an escalation, answer a question, pause/resume.
  Every action earns its place against "could you just do this in GitHub?"

## Shipped: clarifying-question protocol (the ask-don't-guess valve)

The pressure-release valve from REDESIGN.md, wired through **existing channels** (no fragile new
plumbing): when an agent hits a genuine product/UX/data decision the acceptance criteria don't
settle, it writes `.afk/question.json` instead of guessing or escalating wholesale. The host posts
the question as an issue comment + a dashboard card and pauses the issue. Answering on the dashboard
(`answer`) posts the reply as an issue comment and re-queues the issue — so the next run resumes with
the Q&A already in context (the implement prompt's `ISSUE_JSON` includes comments). Tightly scoped in
the prompt: decisions only, one question, never for code or environment problems.

---

## Files

| File | Role |
|------|------|
| `src/core/engine.ts` | Shared host orchestration: implement → merge (conflict→Resolver) → verify → Fixer-loop → PR, plus all safety nets. |
| `src/core/config.ts` | Load + resolve `afk.config.json` (one place for every default + the legacy timeout mapping). |
| `src/core/planner.ts` | Pure issue parsing + epic/milestone feature derivation; `pick()` wraps it with GitHub. |
| `src/core/classify.ts` | Deterministic failure classification → routing. |
| `src/core/verify.ts` | Run the Verifier sandbox; read verdict; collect evidence; render the PR table. |
| `src/core/fix.ts` | Run the Fixer / Resolver agents on the feature branch. |
| `src/core/state.ts` | Append-only event log + pure `reduce()` → dashboard snapshot + live `Store`. |
| `src/core/daemon.ts` | The `afk watch` lifecycle manager (poll, pool, backoff, reconcile, actions). |
| `src/core/server.ts` + `dashboard.ts` | Dashboard HTTP/SSE server + the inline SPA. |
| `src/core/sh.ts` / `types.ts` | Shared shells + tiny pure helpers / shared types. |
| `src/run.ts` / `src/watch.ts` | The two thin drivers. |
| `src/core/*.test.ts` | 22 offline unit tests (planning, routing, state roundtrip, dashboard HTTP/SSE). |
| `.sandcastle/{implement,verify,fix,resolve}-prompt.md` | The four agent-role prompts. |
| `.sandcastle/Dockerfile` | Worker image; now also ships the Docker CLI + compose plugin for the Verifier. |
| `src/init.mjs` | Copies all four prompts; generates the `verify.*` + daemon config keys; auto-detects compose. |

## How it was verified

- `npm run typecheck` (`tsc --noEmit`, `strict: true`) passes.
- `npm test` — 22 unit tests, all offline (no Docker/GitHub/LLM): planner parsing + feature
  derivation, failure classification, the state reducer + file roundtrip (restart recovery) + live
  subscription, and the full dashboard HTTP/SSE/action surface against a stub daemon.
- The dashboard was rendered in a real browser against sample state and looks correct.
- Built only against sandcastle APIs confirmed present in `@ai-hero/sandcastle/dist/index.d.ts`
  (`createSandbox`, `Sandbox.run({ idleTimeoutSeconds, signal })`, the docker provider's `mounts`).

## What still needs live validation (Docker + a target repo + the OAuth token)

These paths are typecheck-clean and designed to degrade safely, but cannot be exercised here:

- **Verifier socket access.** The Verifier runs `docker compose` against the host daemon via the
  bind-mounted socket. The container user (`agent`, uid 1000) needs permission to that socket — on a
  host where it is group-owned, the worker may need to join that gid (or the verify step degrades to
  "unverified"). Validate on a Linux host with a dockerized sample app and tune if needed.
- **compose-from-branch realism** — fresh-DB reset, app-boot detection, and seed-through-the-app for
  a real project's stack.
- **Daemon longevity** — multi-hour polling, real rate-limit backoff/auto-resume, and restart
  reconciliation against a live PR set.

## Roadmap (open second-order items from REDESIGN.md)

- SQLite state store (vs. the current JSONL event log) if the log grows large.
- Multi-repo (one daemon, many repos) and webhook-triggered polling.
- Push notifications for question/escalation cards (the design's optional nicety).
