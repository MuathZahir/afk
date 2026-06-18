---
name: afk
description: Launch the AFK agent loop — drains the repo's `ready-for-agent` issue queue in isolated Docker sandboxes, lands each epic's sub-issues on a feature branch, verifies the feature end-to-end, and opens one verified PR per epic. Use when the user says "run afk", "work the issues", "drain the queue", "watch the queue", or after /to-issues has published ready-for-agent issues.
---

# AFK

Run the autonomous issue → verified-PR loop in the current project. Each issue's **epic parent**
(`## Parent #N`, written by `/to-issues`) is its feature: all of an epic's sub-issues land on one
`feat/<epic#>-<slug>` branch, a dedicated Verifier proves the feature end-to-end, and AFK opens a
single PR per epic that goes *ready* only when it's green. (GitHub milestones still work as a legacy
grouping fallback.)

## Preconditions (check, don't assume)

1. `afk` is installed (`afk --help` works). If not, the project hasn't been set up — run
   `afk init` here (or point the user at the AFK repo's README).
2. `.sandcastle/afk.config.json` exists (created by `afk init`).
3. `~/.afk/.env` (or `.sandcastle/.env`) has `CLAUDE_CODE_OAUTH_TOKEN`. If missing, tell them to
   run `claude setup-token` and `afk init`.
4. Docker is running. `gh auth status` is logged in.
5. Ready issues link to an **epic parent** (`/to-issues` writes this) so they group into a feature;
   issues with neither epic nor milestone fall back to merging straight to the base branch.

## Run

Pick the mode that fits:

```
afk run        # one pass over the queue, then exit
afk watch      # continuous daemon + dashboard at http://localhost:7777
```

For `afk run`: stream the output, then read `AFK-REPORT.md` and summarise — how many issues landed,
which **feature PRs** opened (link each, note verified vs. unverified), and how many routed to
`ready-for-human`.

For `afk watch`: tell the user the dashboard URL; it stays up monitoring + lets them merge/re-queue/
answer. It backs off and auto-resumes on rate limits.

Either way: remind them to check out a feature branch to test it, then merge its PR. Offer `/triage`
over the `ready-for-human` pile, and `afk changelog` when cutting a release.
