# AFK

Drain a GitHub `ready-for-agent` issue queue while you sleep. Isolated Claude Code workers
implement each issue in a Docker sandbox; **each epic becomes one feature branch that is verified
end-to-end before its PR goes ready** for you to merge. Runs on your **Claude subscription** (no API
key). Drop-in to any GitHub repo.

```
afk init  →  /grill-with-docs  →  /to-issues  →  afk run    →  review verified PRs  →  merge
 setup        design             publish          (or watch)     test on the branch
              (epic parent =      ready-for-agent  implement →
               one feature)       + sub-issues     verify → PR
```

Two ways to run it:

- **`afk run`** — drain the queue once, then exit. Great for a "work the backlog while I'm out" pass.
- **`afk watch`** — a continuous daemon with a **local dashboard** (`localhost:7777`): it keeps
  polling, runs the full implement → verify → fix loop, backs off and auto-resumes on rate limits,
  and lets you watch each agent's **live transcript** (what it's saying + every tool call), **stop**
  a stuck worker, merge a ready PR, re-queue an escalation, or answer an agent's question — one click.

Built on **[Sandcastle](https://github.com/mattpocock/sandcastle)** (the isolation / worktree /
merge engine — used as a library, not forked) and the **[Matt Pocock skills](https://github.com/mattpocock)**
(`to-issues`, `triage`, `tdd`, `find-docs`, …). AFK is the thin autonomous layer on top: a small
CLI that orchestrates the queue, routes work to feature branches, and opens PRs.

---

## How it works

```
HOST (deterministic TypeScript — no LLM)              SANDBOXED AGENTS (per task, Docker)
──────────────────────────────────────────            ───────────────────────────────────
plan:   gh issue list --label ready-for-agent
        group by epic (## Parent) → feat/<epic#>-<slug>
        ↓ (up to maxParallel at once)
        createSandbox(branch afk/issue-N,
                      baseBranch feat/…)      ────────▶ IMPLEMENTER (Opus, tdd)
                                                         scoped tests · commit · summary.md
        merge afk/issue-N → feat/…  ◀──────────────────  (host trusts + merges; conflict → Resolver)
        ↓ when every child of the epic has landed
        verify the feature branch              ────────▶ VERIFIER (Sonnet, from the branch's stack)
                                                         compose up · fresh DB · agent-browser + API
                                                         per-criterion verdict + evidence · down -v
        verdict ─┬─ green ──▶ PR ready + evidence
                 └─ fail ──▶ classify → FIXER (Opus) loop ↺ re-verify · conflict → RESOLVER
                                       flaky → one re-run · env/ambiguous → escalate w/ evidence
report: AFK-REPORT.md (afk run)  ·  live dashboard (afk watch)  ·  `afk changelog` at release
```

Design choices that make it lean and safe — and why:

- **No host gate, but a real Verifier.** The implementer runs the tests covering *its* change and
  commits only when they pass; the host trusts that branch and merges it. Then a dedicated
  **Verifier** brings the whole feature up from the branch's own stack and proves every acceptance
  criterion in a browser + via the API, posting evidence to the PR. The PR only goes *ready* once
  it's green — so you merge verified work, not a hopeful diff. (A host gate that re-ran the unit
  suite was the biggest source of failed-to-merge runs; the Verifier replaces it with a realistic
  end-to-end check that doesn't inherit the repo's red baseline.)
- **One epic = one feature = one branch = one verified PR.** The `## Parent` epic that `to-issues`
  already writes *is* the feature grouping — no manual milestone juggling. Master stays clean; you
  check out a feature branch, test, merge its PR. (GitHub milestones still work as a legacy
  fallback; issues with neither merge straight to the base branch.)
- **The worker has no GitHub token.** The issue is injected into its prompt; every GitHub mutation
  (merge, comment, close, PR, asset upload) happens on the host. Smaller blast radius.
- **Failures self-correct, then route to humans — by type.** A worker stuck on its *own* code gets a
  bounded retry (`maxFixAttempts`); a failing Verifier verdict is classified and routed —
  logic→Fixer loop, merge conflict→Resolver, flaky→one re-run, **environment/ambiguous→`ready-for-human`
  with full evidence**. Quota is never burned grinding on infra an agent can't fix. Sweep the pile with `/triage`.
- **No lost work.** If a worker finishes (or times out) without committing, the host commits its
  uncommitted source changes so nothing is thrown away, and routes it to a human.
- **Verify degrades honestly.** No compose stack, an unsupported host, or a stack that won't boot →
  the PR is marked **"unverified — test manually"**, never a false green.

---

## Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| **Claude Code** | Install the CLI (`npm install -g @anthropic-ai/claude-code`) or the desktop app. **Pro or Max plan required** — AFK uses your subscription, not an API key. |
| **Docker Desktop** | Running before you call `afk init` or `afk run`. |
| **GitHub CLI** | `gh auth login` (needs repo + issues scope). |
| **Skills** (optional) | AFK bakes Claude Code skills into the worker image so agents can use `/tdd`, `/find-docs`, etc. without re-downloading them each run. If you already have skills in `~/.claude/skills/` they're picked up automatically. If you don't, AFK still works — agents fall back to their built-in capabilities. See [Skills](#skills) below. |

## Setup — one command

```bash
# 1. clone this repo and install the CLI (once per machine):
git clone https://github.com/MuathZahir/afk.git
cd afk && npm install && npm link     # provides the global `afk` command

# 2. get your Claude OAuth token (once per machine):
#    run this inside the claude CLI or desktop app, then copy the token it prints:
claude setup-token
#    save it where afk looks for it (works in bash, zsh, and PowerShell 7+):
mkdir -p ~/.afk && echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > ~/.afk/.env

# 3. set up AFK in a project (once per project, run from the project root):
afk init
```

> **Why a file and not an environment variable?** `~/.afk/.env` is read only by the afk
> orchestrator, which passes the token only into the worker containers. Setting
> `CLAUDE_CODE_OAUTH_TOKEN` globally (e.g. `setx` on Windows or `~/.bashrc`) also works, but it
> overrides the login auth of **every** `claude` session on your machine — avoid it unless that's
> what you want. For a per-project token, use `.sandcastle/.env` instead (takes precedence over
> the global file).

`afk init` does **everything**: saves your token to `~/.afk/.env` (reused by every project),
builds the shared `afk-worker` image with your skills baked in (once; `--rebuild` to refresh),
copies the per-project harness (`implement-prompt.md`, `Dockerfile`) into `.sandcastle/`,
auto-generates `.sandcastle/afk.config.json`, and updates `.gitignore`. The orchestrator itself is
**not** copied — it lives in the `afk` package and runs via `afk run`.

## Skills

Skills are short Markdown prompt files stored in `~/.claude/skills/`. The worker image bakes them
in at build time so agents can invoke them as `/skill-name` without network access per-run.

**Default baked skills:** `tdd`, `find-docs`, `diagnose`, `frontend-design`.  
**Choose your own:** `afk init --skills tdd,find-docs,my-custom-skill,…`  
**`expect`** (browser screenshots) is an MCP server wired up in the Dockerfile, not a skill file.

Where to get skills:
- Many are available from the [Matt Pocock skill ecosystem](https://github.com/mattpocock) — install
  by copying the skill file into `~/.claude/skills/<name>`.
- Write your own: a skill is just a Markdown file with instructions the agent reads when you invoke
  `/skill-name`. Drop it in `~/.claude/skills/` and rebuild the image with `afk init --rebuild`.

If a skill isn't found during `afk init`, it's skipped with a warning — the image still builds and
agents work fine, just without that skill available.

## Use

```bash
# 1. design + publish issues (standard Matt Pocock skills — AFK doesn't modify them)
/grill-with-docs
/to-issues          # writes an epic parent issue + sub-issues with `## Parent #N` links

# 2. let the agents work — either:
afk run             # one pass, then exit  (read AFK-REPORT.md after)
# …or…
afk watch           # continuous daemon + dashboard at http://localhost:7777
```

There's **no manual grouping step** anymore: the `## Parent` epic that `/to-issues` already creates
is the feature. All of an epic's sub-issues land on `feat/<epic#>-<slug>`, the feature is verified
end-to-end, and one PR per epic goes *ready* when it's green.

In the morning (or live on the dashboard): **check out a feature branch and test it**, then merge
its PR. `/triage` the `ready-for-human` pile. At release time, `afk changelog --release v1.3.0`.

> Uses only stock GitHub + skills, so the workflow stays portable and shareable. GitHub milestones
> still work as a legacy grouping fallback if you prefer them.

## Commands

| Command | What |
| ------- | ---- |
| `afk init [project]` | Set up AFK: token · worker image · skills · config |
| `afk run` | Drain the queue once; each epic → one verified feature branch + PR, then exit |
| `afk watch` | Continuous daemon + local dashboard (monitor · merge · re-queue · answer) |
| `afk changelog [--from <ref>] [--write] [--release <tag>]` | Conventional-Commit release notes since the last tag |

## Config (`.sandcastle/afk.config.json`)

| Key | Default | Notes |
| --- | --- | --- |
| `baseBranch` | current branch | PRs target this branch |
| `maxParallel` | `2` | concurrent workers (respects subscription rate windows) |
| `maxIssuesPerRun` | `5` | cap per `afk run` |
| `idleTimeoutMin` | `10` | kill a worker after this long with **no activity** (the real "stuck" signal) |
| `absoluteTimeoutMin` | `90` | hard backstop so a productively-working long task is never cut off mid-work (legacy `issueTimeoutMin` is still honored as this) |
| `maxFixAttempts` | `1` | self-correction tries: implementer stuck on own code, **and** Fixer attempts on a failing verify, before escalating |
| `model` | `opus` | default agent model (fallback for `models`) |
| `models` | per-role | `{ implement: opus, verify: sonnet, fix: opus, classify: haiku }` — tuned for subscription rate-windows |
| `setup` | auto-detected | install command run **inside** the Linux container |
| `verify` | auto-detected | `{ enabled, baseUrl, up, down, dbReset, appBoot, seed, secrets, backendOnly, timeoutSec }` — the verification env contract (see below) |
| `pollSeconds` | `60` | `afk watch`: seconds between queue polls |
| `dashboardPort` | `7777` | `afk watch`: localhost port for the dashboard |
| `labels` | `ready-for-agent` / `ready-for-human` | queue + escalation labels |

### Verification (`verify.*`)

When all of an epic's sub-issues have landed, the **Verifier** (Sonnet) brings the app up *from the
feature branch's own stack* in an isolated project (`docker compose -p verify_<feat>`), runs a fresh
DB, exercises every acceptance criterion via a real browser + direct API calls, and posts a
per-criterion verdict + screenshots to the PR. AFK auto-detects a `docker compose` file and sensible
defaults; override any step per repo. With **no** compose stack (or on a Windows host, whose
named-pipe Docker daemon can't be socket-mounted) the feature is marked **"unverified — test
manually"** rather than failed — never a false green. Set `verify.enabled: false` to skip it.

> The Verifier runs `docker compose` against the **host** daemon (the socket is bind-mounted into
> its sandbox), so `afk init` adds the Docker CLI to the worker image — run `afk init --rebuild`
> after upgrading to pick it up.

## Known limitations

- Serial-ish by design (`maxParallel: 2`) to respect subscription rate windows; the `afk watch`
  daemon backs off and auto-resumes when a rate window resets.
- Merge conflicts get a dedicated **Resolver** attempt before escalating; only genuinely
  irreconcilable ones route to `ready-for-human`. Independent vertical slices (what `to-issues`
  produces) make these rare.
- End-to-end **verification needs a dockerized stack** and a Unix host (the Verifier mounts the
  Docker socket). Without one, features still implement + merge but ship **unverified** PRs you test
  manually.
- AFK pushes **feature branches** and opens PRs, but never pushes or force-pushes the base branch —
  you (or the dashboard's one-click merge) merge the PRs yourself.
