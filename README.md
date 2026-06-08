# AFK

Drain a GitHub `ready-for-agent` issue queue while you sleep. Isolated Claude Code workers
implement each issue in a Docker sandbox; **each milestone becomes one feature branch with one
PR** for you to test and merge. Runs on your **Claude subscription** (no API key). Drop-in to any
GitHub repo.

```
afk init  →  /grill-with-docs  →  /to-issues  →  afk run  →  review the feature PRs  →  merge
 setup        design             publish          agents work       test on the branch
              (milestone =        ready-for-agent  → feat/<slug> +
               one feature)       issues           one PR per feature
```

Built on **[Sandcastle](https://github.com/mattpocock/sandcastle)** (the isolation / worktree /
merge engine — used as a library, not forked) and the **[Matt Pocock skills](https://github.com/mattpocock)**
(`to-issues`, `triage`, `tdd`, `find-docs`, …). AFK is the thin autonomous layer on top: a small
CLI that orchestrates the queue, routes work to feature branches, and opens PRs.

---

## How it works

```
HOST (deterministic TypeScript — no LLM)          CONTAINER (one agent per issue)
──────────────────────────────────────────        ──────────────────────────────────
plan:   gh issue list --label ready-for-agent
        group by milestone → feat/<slug>
        ↓ (up to maxParallel at once)
        createSandbox(branch afk/issue-N,
                      baseBranch feat/<slug>) ────▶ implement (tdd)
                                                     run the tests covering the change
                                                     (frontend-design for UI, expect for
                                                      browser proof, find-docs for APIs)
                                                     commit · write .afk/summary.md
        merge afk/issue-N → feat/<slug>  ◀────────  (agent commits; host trusts + merges)
        ↓ when the milestone is done
        gh pr create feat/<slug> → base  (one PR per feature, Closes #…)
report: AFK-REPORT.md  (+ `afk changelog` at release time)
```

Design choices that make it lean and safe — and why:

- **No host gate.** The agent runs the tests covering *its* change and commits only when they
  pass; the host trusts that committed branch and merges it. Your safety net is reviewing the
  **feature PR** before you merge it — not a brittle re-run of the whole suite on the host. (A host
  gate that re-ran the suite was the single biggest source of failed-to-merge runs: it inherited
  the repo's red-test baseline and got auto-backgrounded mid-run. Removing it fixed both.)
- **One milestone = one feature = one branch = one PR.** Master stays clean; you check out a
  feature branch, test the whole thing, and merge its PR when happy. Issues with no milestone fall
  back to merging straight to the base branch.
- **The worker has no GitHub token.** The issue is injected into its prompt; every GitHub mutation
  (merge, comment, close, PR, asset upload) happens on the host. Smaller blast radius.
- **Failures route to humans, not retries.** A stuck issue gets `ready-for-human` and is skipped
  thereafter, so it never silently burns quota in a loop. Sweep them with `/triage`.
- **No lost work.** If a worker finishes (or times out) without committing, the host commits its
  uncommitted source changes so nothing is thrown away, and routes it to a human.

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
git clone <this-repo-url>
cd afk && npm install && npm link     # provides the global `afk` command

# 2. get your Claude OAuth token (once per machine):
#    run this inside the claude CLI or desktop app, then copy the token it prints:
claude setup-token
#    save it so afk can find it — on Windows:
setx CLAUDE_CODE_OAUTH_TOKEN <token>
#    on macOS/Linux:
export CLAUDE_CODE_OAUTH_TOKEN=<token>   # or add to ~/.bashrc / ~/.zshrc

# 3. set up AFK in a project (once per project, run from the project root):
afk init
```

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
/to-issues

# 2. group the issues into a feature — create a milestone and assign them (standard GitHub):
gh api repos/:owner/:repo/milestones -f title="Roleplay history"
gh issue edit 12 13 14 --milestone "Roleplay history"

# 3. let the agents work
afk run
```

In the morning: read `AFK-REPORT.md`, **check out each feature branch and test it**, then merge its
PR. `/triage` the `ready-for-human` pile. At release time, `afk changelog --release v1.3.0`.

> Milestones are how AFK groups issues into features — assign one per feature. This uses only
> stock GitHub + skills, so the workflow stays portable and shareable.

## Commands

| Command | What |
| ------- | ---- |
| `afk init [project]` | Set up AFK: token · worker image · skills · config |
| `afk run` | Drain the queue; one milestone → one feature branch + PR |
| `afk changelog [--from <ref>] [--write] [--release <tag>]` | Conventional-Commit release notes since the last tag |

## Config (`.sandcastle/afk.config.json`)

| Key | Default | Notes |
| --- | --- | --- |
| `baseBranch` | current branch | PRs target this branch |
| `maxParallel` | `2` | concurrent workers (respects subscription rate windows) |
| `maxIssuesPerRun` | `5` | cap per `afk run` |
| `issueTimeoutMin` | `30` | per-issue wall-clock budget |
| `model` | `opus` | agent model |
| `setup` | auto-detected | install command run **inside** the Linux container |
| `labels` | `ready-for-agent` / `ready-for-human` | queue + escalation labels |

## Known limitations

- Serial-ish by design (`maxParallel: 2`) to respect subscription rate windows.
- Merge conflicts within a feature branch route to `ready-for-human`. Independent vertical slices
  (what `to-issues` produces) make these rare.
- AFK pushes **feature branches** and opens PRs, but never pushes or force-pushes the base branch —
  you merge the PRs yourself.
