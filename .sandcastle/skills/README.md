# Skill-pack

These folders are copied into the worker container at `~/.claude/skills/` (see the
`Dockerfile` `COPY`). The worker self-selects from them per the menu in
`implement-prompt.md`.

## What to vendor here

Copy the skill folders you want the worker to have. The defaults the prompt references:

| Skill | Why the worker needs it |
|---|---|
| `tdd` | the implementation loop (red → green → refactor) |
| `find-docs` | current library/API docs via context7 (don't guess APIs) |
| `frontend-design` | UI changes that match the design system |
| `diagnose` | reproduce bugs before fixing |

Vendor them from your local install, e.g. on Windows:

```powershell
Copy-Item -Recurse "$env:USERPROFILE\.claude\skills\tdd"             .\.sandcastle\skills\
Copy-Item -Recurse "$env:USERPROFILE\.claude\skills\find-docs"       .\.sandcastle\skills\
Copy-Item -Recurse "$env:USERPROFILE\.claude\skills\diagnose"        .\.sandcastle\skills\
# add frontend-design (or your design skill of choice) similarly
```

Vendoring (rather than cloning at build time) keeps the worker reproducible and offline-safe.
Re-copy when you update a skill. Anything you drop in here is available to the worker — add
project-specific skills freely.

> `.gitignore` ignores everything here except this README so you don't commit large/3rd-party
> skill copies. Remove that ignore line if you'd rather pin them in git.
