---
name: afk
description: Launch the AFK agent loop — drains the repo's `ready-for-agent` issue queue in isolated Docker sandboxes, lands each milestone's work on a feature branch, opens a PR per feature, and posts per-issue summaries + screenshots. Use when the user says "run afk", "work the issues", "drain the queue", or after /to-issues has published ready-for-agent issues.
---

# AFK

Run the autonomous issue-draining loop in the current project. Each issue's **milestone** is its
feature: all of a milestone's issues land on one `feat/<slug>` branch, and AFK opens a single PR
per feature for the user to test and merge.

## Preconditions (check, don't assume)

1. `afk` is installed (`afk --help` works). If not, the project hasn't been set up — run
   `afk init` here (or point the user at the AFK repo's README).
2. `.sandcastle/afk.config.json` exists (created by `afk init`).
3. `~/.afk/.env` (or `.sandcastle/.env`) has `CLAUDE_CODE_OAUTH_TOKEN`. If missing, tell them to
   run `claude setup-token` and `afk init`.
4. Docker is running. `gh auth status` is logged in.
5. Ready issues are assigned to a **milestone** (the feature) — issues with no milestone fall back
   to merging straight to the base branch.

## Run

```
afk run
```

Stream the output. When it finishes, read `AFK-REPORT.md` and summarise for the user: how many
issues landed, the **feature PRs** opened (link each), and how many were routed to
`ready-for-human`.

Remind them to check out a feature branch to test it, then merge its PR. Offer to run `/triage`
over the `ready-for-human` pile, and `afk changelog` when cutting a release.
