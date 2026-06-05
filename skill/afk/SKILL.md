---
name: afk
description: Launch the AFK agent loop — drains the repo's `ready-for-agent` issue queue in isolated Docker sandboxes, merges verified work, and posts per-issue summaries + videos. Use when the user says "run afk", "work the issues", "drain the queue", or after /to-issues has published ready-for-agent issues.
---

# AFK

Run the autonomous issue-draining loop in the current project.

## Preconditions (check, don't assume)

1. `.sandcastle/run.ts` exists in this repo. If not, the project hasn't been set up — point
   the user at the AFK repo's README (`npx tsx <afk>/scripts/install.mjs <here>`).
2. `.sandcastle/.env` has `CLAUDE_CODE_OAUTH_TOKEN`. If missing, tell them to run
   `claude setup-token` and paste it in.
3. `.sandcastle/afk.config.json` exists (copied from `afk.config.example.json` and filled with
   this project's `typecheck` / `test` / `dev` / `baseUrl`).
4. Docker is running. `gh auth status` is logged in.
5. The working tree is clean and on the base branch.

## Run

```
npx tsx .sandcastle/run.ts
```

Stream the output. When it finishes, read `AFK-REPORT.md` and summarise for the user:
how many merged, how many were routed to `ready-for-human`, and link any videos.

If `push: false` (the default), remind them the merges are local — `git log` then `git push`
when happy. Offer to run `/triage` over the `ready-for-human` pile.
