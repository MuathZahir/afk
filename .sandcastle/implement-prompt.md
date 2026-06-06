# TASK

Implement issue **#{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}** on branch `{{BRANCH}}`.

Work on this issue ONLY. The full issue (body + comments) is below — you do **not** have
GitHub access, so everything you need is here:

<issue>
{{ISSUE_JSON}}
</issue>

# GROUND RULES

- You are on branch `{{BRANCH}}` in an isolated container. Commit your code changes here.
- Do **not** push, do **not** comment on or close the issue, do **not** touch the remote.
  The host handles merge, asset upload, comment, and close after you finish.
- The `.afk/` directory is scratch for this run — **never commit it** (it's gitignored).
- **Never commit `package-lock.json` / lockfile changes or `node_modules`.** The container
  installs platform-specific binaries; that churn must not reach the branch. Commit only the
  source changes your issue actually requires (`git add` specific paths, not `git add -A`).
- When everything below is done, output `<promise>COMPLETE</promise>`.

# SKILLS — use the right one for the job

- **tdd** — always, for the implementation. Red → green → refactor.
- **find-docs** (context7) — whenever you touch a library/SDK/API you're not 100% current on. Don't guess API shapes.
- **frontend-design** — any UI/visual change. Match the existing design system; keep it accessible.
- **diagnose** — if the issue is a bug, reproduce it first before fixing.

(Any other skill installed in the image is fair game — use what the task needs.)

# STEPS

> **Ordering is deliberate: TEST and COMMIT come BEFORE the optional screenshots.** The host merges
> any branch you commit to — so committing is the only thing that makes your work land. Screenshots
> are nice-to-have evidence with *zero* effect on the merge. Do the merge-critical steps first so
> that even if the screenshot step explodes (missing browser, GPU-less renderer, timeout), your work
> still lands. **An agent that chases screenshots before committing throws away everything it built.**

1. **Explore** the repo to understand the code paths this issue touches. Read the relevant
   tests and the surrounding modules. Use the project's own conventions.

2. **Implement** the acceptance criteria using **tdd**. Keep the change a thin vertical slice —
   exactly what the issue asks, no scope creep.

3. **Self-review** your diff: remove dead code, tighten names, drop redundant comments, make sure
   you didn't break adjacent behavior. Preserve functionality.

   **Typecheck YOUR code only — do NOT touch the baseline.** This monorepo has a KNOWN
   pre-existing red full-typecheck baseline (drizzle dual-package skew in `api_v2`, stale Next
   route codegen, etc.) — it is red on a clean checkout of the base branch, before you change
   anything. It is **not yours to fix**. So:
   - ✅ Do typecheck the package/app you changed, scoped and fast (e.g. `cd packages/api_v2 && npx
     tsc --noEmit` or `npx tsc -p apps/web_v2/tsconfig.json`) and make sure **your** files are clean.
   - ❌ Do **NOT** run the full-monorepo typecheck / `npm run check-types`. Do **NOT** `git stash`
     and re-count total errors to "prove" they're pre-existing. Do **NOT** try to fix baseline
     errors in files you didn't touch. That is exactly the time-and-token sink to avoid — the gate
     does not check the full typecheck, so neither should you.

4. **Write `.afk/summary.md`** — 4–8 lines for a human who will NOT read the code:
   what you built, key decisions/trade-offs, and the files you touched.

5. **Self-check YOUR OWN tests, then COMMIT.** Run only the tests you wrote or that cover your
   change — scoped and fast (e.g. `node --test --import tsx path/to/your.test.ts`, or your
   package's `npm test` if it's quick). Make them green. **Do NOT run `.sandcastle/lib/afk-gate.sh`
   yourself** — the **host runs the authoritative full gate after you finish**. The full suite takes
   minutes; if you run it, the harness auto-backgrounds it and your run ends before it completes —
   pure waste. Your job is just to make sure *your* code's tests pass.

6. **Commit** your code changes with a clear message — specific paths only, **never** `.afk/`,
   `node_modules`, or lockfiles. **Commit the moment your own tests pass — this is the most
   important step; never end your turn with uncommitted work.** The host gates and merges from your
   commit; uncommitted work cannot be merged.

7. **OPTIONAL — live proof, STRICTLY time-boxed.** Only if the issue changes something a user can
   see, and only after steps 5–6 are done. This is bonus evidence, **not** the gate.
   - **Hard cap: ONE attempt, ≤2 minutes total. The moment anything environmental gets in the way —
     dev server won't boot, browser/native binary missing, GPU/WebGL/renderer errors, a download
     that stalls — STOP immediately, skip the rest, and go to step 8.** Do **not** retry, do **not**
     reinstall browsers, do **not** hand-launch chrome with workaround flags. Note
     `visual unverified (env): <one line>` in `.afk/summary.md` and move on. Your gated+committed
     work is complete regardless. Grinding here is the #1 way agents waste their whole budget.
   - Start the app from `package.json` (e.g. `npm run dev`) in the background; note the port.
   - Use the **expect skill** (`mcp__expect__open`, `mcp__expect__playwright`,
     `mcp__expect__screenshot`) to step through the acceptance criteria like a user. Save each
     screenshot to `.afk/shots/NN-label.png` (zero-padded, e.g. `01-empty-form.png`).
   - If you captured shots, stitch the GIF: `bash .sandcastle/lib/make-gif.sh`.
   - Write **`.afk/e2e.json`**: `{ "ok": true, "note": "what you verified" }` if it works. Only
     write `{ "ok": false, "note": "..." }` if **your feature is genuinely broken** (not if the
     environment merely blocked you — an env block means SKIP, leave no `e2e.json`). The host treats
     `ok:false` as a failed gate, so never use it for environmental problems.
   - Backend-only / nothing visual → skip this whole step (no `.afk/e2e.json`).

8. Output `<promise>COMPLETE</promise>`.

# KEEP YOUR CHECKS SMALL AND IN THE FOREGROUND — NEVER POLL IN THE BACKGROUND

The single most common way a worker throws away good work: it launches a **slow** command (the full
test suite) as a **background** job, then burns its entire turn budget polling with `sleep` or
`until grep ... /tmp/*.out` loops — and the run ends BEFORE it commits. The work is done but
uncommitted, and **uncommitted work is lost.** This is why **you don't run the full gate** — the
host does (see step 5).

- Run only **your own, scoped, fast** tests — synchronously, in the foreground, with a `timeout`.
  Wait for them to return; read the output directly.
- Do **NOT** start anything as a background task and poll a `/tmp/*.out` file. Do **NOT** `sleep` in
  a loop. Do **NOT** run the full `npm run test --workspaces` — nobody needs it; just your scoped tests.
- **Commit the instant your own tests pass (step 6) — before any optional/visual work.** Never end
  your turn with uncommitted changes. A committed imperfect change survives; an uncommitted perfect
  one does not.

# BAIL FAST ON ENVIRONMENT PROBLEMS — DO NOT RABBIT-HOLE

Your job is **this one issue**, not repairing the toolchain. The single biggest way you waste
time and tokens is grinding on infrastructure that isn't your fault. Don't.

**Tell the two apart:**
- **Caused by your change** (a test you broke, a type error in your code, your feature not
  working) → fix it. That's the job.
- **Pre-existing / environmental** — missing native binaries, the app won't install or boot, a
  broken dependency, a failure that exists on a clean checkout of the base branch too → **NOT
  yours to fix.** Quick sanity check: would `git stash` (dropping your changes) make the error go
  away? If yes, it's environmental.

**Scope:** bail is for when the environment blocks the **core work** — you can't install, can't run
your tests, the repo won't build at all. It is **NOT** for when only the **screenshot/dev-server**
step is blocked — that path is handled in step 7 (skip the visual, keep going). If you can run your
own tests and they pass, you are NOT blocked — commit and finish normally.

**When the core work is environmentally blocked, bail after AT MOST one or two quick attempts**
(a few minutes, not an hour). To bail:

1. Commit whatever real progress you made (specific paths only — never `node_modules`/lockfiles).
2. Write `.afk/blocked.json`:
   ```json
   { "reason": "one line — what's broken", "detail": "what you saw + what you tried" }
   ```
3. Write the same into `.afk/summary.md`.
4. Output `<promise>COMPLETE</promise>`.

The host will **push your branch and tag the issue for a human** — your partial work is kept, not
thrown away. Bailing early on a tooling problem is the **correct, expected** outcome. Spending an
hour and a chunk of the token budget fixing someone else's broken install is a failure, even if it
eventually works.

# IF YOU'RE STUCK ON YOUR OWN CODE

If the bug *is* yours but you genuinely can't get your tests green (hard or underspecified issue),
write what blocked you into `.afk/summary.md` **and `.afk/blocked.json`** (so the host routes it to
a human instead of merging it), commit what you have, and output `<promise>COMPLETE</promise>`. That
is a fine outcome — far better than committing code you know is broken as if it were done.
