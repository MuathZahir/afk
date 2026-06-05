# AFK

Drain a GitHub `ready-for-agent` issue queue while you sleep. Isolated Claude Code workers
implement each issue in a Docker sandbox, a deterministic script gates and merges the work, and
each issue gets a summary comment + inline screenshots/GIF of the feature running. Runs on your **Claude
subscription** (no API key). Drop-in to any GitHub repo.

```
/grill-me   →   /to-issues   →   npx tsx .sandcastle/run.ts
 design          publish              agents work; you wake to merged
                 ready-for-agent      commits + per-issue summaries & screenshots
```

Built on [Sandcastle](https://github.com/mattpocock/sandcastle) (the isolation/worktree/merge
engine) and the [Matt Pocock skills](https://github.com/mattpocock) (`to-issues`, `triage`,
`tdd`, `find-docs`, …). AFK is the thin autonomous layer on top — it lives entirely in
`.sandcastle/`; there is no new engine and no CLI to maintain.

---

## How it works

```
HOST (deterministic TypeScript — no LLM)        CONTAINER (one agent per issue)
────────────────────────────────────────        ──────────────────────────────────
plan:   gh issue list --label ready-for-agent
        parse "Blocked by #N", skip if open
        ↓ (up to maxParallel at once)
        createSandbox(branch afk/issue-N) ──────▶ implement (tdd)
                                                   verify in browser via expect skill,
                                                     screenshots → .afk/shots/*.png,
                                                     verdict → .afk/e2e.json
                                                   self-review + .afk/summary.md
                                                   make-gif.sh + afk-gate.sh ─┐
        read .afk/gate.json + e2e.json  ◀──────────────────────────────────  ┘ SCRIPT writes verdict
        typecheck+unit green AND browser ok?
          ├─ yes → git merge → upload GIF+shots to a Release → comment (inline) + close
          └─ no  → drop branch → comment diagnostics → relabel ready-for-human
        ↓ re-query (a closed issue can unblock its dependents this run)
report: AFK-REPORT.md
```

Design choices that make it lean and safe — and why:

- **No planner/merger/reviewer agents.** Planning and merging are deterministic TS; review is
  folded into the worker. ~60% fewer agent calls than a naive loop → your Max quota lasts.
- **The hard gate is a script, not the model's opinion.** `afk-gate.sh` runs typecheck + unit and
  writes `.afk/gate.json` from real exit codes. The host refuses to merge unless that file is
  green. Defeats "the agent thinks the tests pass."
- **Visual proof comes from the agent driving the browser** with the **expect** skill — it steps
  through the acceptance criteria, screenshots each moment, and writes an `ok/not-ok` verdict
  (`.afk/e2e.json`). `not-ok` blocks the merge; the screenshots + a stitched GIF embed **inline**
  in the issue comment so you see the feature without clicking.
- **The worker has no GitHub token.** The issue is injected into its prompt; every GitHub
  mutation (merge, comment, close, asset upload) happens on the host. Smaller blast radius.
- **Failures route to humans, not retries.** A stuck issue gets `ready-for-human` and is skipped
  thereafter, so it never silently burns quota in a loop. Sweep them with `/triage`.

---

## Setup — one command

Prereqs: Docker running, `gh auth` logged in, and `claude setup-token` run once (Pro/Max).

```bash
# set the token once (any of these — the installer picks it up and saves it globally):
setx CLAUDE_CODE_OAUTH_TOKEN <token-from-claude-setup-token>

# then, in (or pointing at) any project:
node <path-to-afk>/scripts/install.mjs .
```

That single command does **everything**:

- saves your token to `~/.afk/.env` — set once, reused by every project after this
- builds the shared `afk-worker` image with your skills baked in (once; skipped if it exists)
- installs `@ai-hero/sandcastle @playwright/test tsx` in the project
- **auto-generates** `.sandcastle/afk.config.json` from the project's `package.json`
  (detects `typecheck` / `test` / `dev` / port / base branch / package manager)
- copies the harness in and updates `.gitignore`

Glance at the generated `afk.config.json` — detection guesses your `typecheck`/`test` commands.
(No `dev`/`baseUrl` needed — the worker drives the browser itself via the expect skill.)
Re-run with `--rebuild` to refresh the baked skills, or `--skills tdd,find-docs,...` to choose them.

## Run

```bash
npx tsx .sandcastle/run.ts        # or the /afk skill
```

In the morning: read `AFK-REPORT.md`, glance at the inline screenshots on each closed issue,
`git push` what you like, `/triage` the rest.

---

## First-run checklist (can't be tested without Docker + a real queue)

These are the spots to watch the very first time — they depend on your project + host:

- [ ] **Image builds.** The installer runs `docker build` for `afk-worker` — Playwright
      `--with-deps` + user-id alignment are the likely friction points. Tune `.sandcastle/Dockerfile`
      and re-run the installer with `--rebuild` if it fails.
- [ ] **`setup` is enough.** `npm ci` must produce a runnable app in-container. Monorepos may
      need a workspace-aware install or a build step.
- [ ] **expect works headless in the container.** The highest-risk piece: the `expect-mcp`
      server must launch and find chromium (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`). If the
      worker can't drive the browser, fall back to the bundled `agent-browser` CLI skill. Test
      on a UI issue first.
- [ ] **Merge/branch lifecycle.** Start with `maxIssuesPerRun: 1` and one simple issue; confirm
      it merges to local `baseBranch` and the `afk/issue-N` branch is cleaned up.
- [ ] **Cross-platform deps.** On a Windows host, deps install *inside* the Linux container
      (`setup`), never copied from the host — keep it that way.

## Known limitations (v1)

- Serial-ish by design (`maxParallel: 2`) to respect subscription rate windows. Bump it (and
  switch to an API key) only once the single-worker path is proven.
- Merge conflicts aren't auto-resolved — they route to `ready-for-human`. Independent vertical
  slices (what `to-issues` produces) make these rare.
- `push: false` by default. AFK never force-pushes and never touches remote history.
