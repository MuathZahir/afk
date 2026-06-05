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
- **web-design-guidelines** — any UI/visual change. Match the existing design system; keep it accessible.
- **diagnose** — if the issue is a bug, reproduce it first before fixing.

(Any other skill installed in the image is fair game — use what the task needs.)

# STEPS

1. **Explore** the repo to understand the code paths this issue touches. Read the relevant
   tests and the surrounding modules. Use the project's own conventions.

2. **Implement** the acceptance criteria using **tdd**. Keep the change a thin vertical slice —
   exactly what the issue asks, no scope creep.

3. **If this issue changes anything a user can see in the browser, verify it live and capture
   proof.** This is the "watch it in action" artifact attached to the issue. It is **optional
   evidence**, not the gate — the hard gate (step 7) is typecheck + unit and does NOT need a
   running app.
   - Start the app yourself — figure out the dev command from `package.json` (e.g. `npm run dev`)
     and run it in the background; note the port.
   - Use the **expect skill** (`mcp__expect__open`, `mcp__expect__playwright`,
     `mcp__expect__screenshot`) to open the app and step through the issue's acceptance criteria
     like a user would.
   - At each meaningful step, capture a screenshot and **save it to `.afk/shots/NN-label.png`**
     (zero-padded order, e.g. `01-empty-form.png`, `02-submitted.png`) — copy the file expect
     returns into that path. These become the inline screenshots + GIF on the issue.
   - If the feature works, write **`.afk/e2e.json`** = `{ "ok": true, "note": "what you verified" }`.
     If it's genuinely **broken** (your feature doesn't do what the issue asks), write
     `{ "ok": false, "note": "what's wrong" }` — the host treats `ok:false` as a failed gate.
   - **If the dev server won't boot for an ENVIRONMENTAL reason** (missing native binary, infra) —
     do **NOT** bail and do **NOT** write `e2e.json: ok:false`. Just **skip the screenshots**,
     note "visual unverified — dev server wouldn't boot (env): <detail>" in `.afk/summary.md`, and
     carry on to the gate. Green typecheck + unit is enough to merge; the missing screenshot is not
     a failure of your work.
   - If the issue is backend-only with nothing visual, skip this whole step (no `.afk/e2e.json`).

4. **Self-review** your diff before gating: remove dead code, tighten names, drop redundant
   comments, make sure you didn't break adjacent behavior. Preserve functionality.

5. **Write `.afk/summary.md`** — 4–8 lines for a human who will NOT read the code:
   what you built, key decisions/trade-offs, and the files you touched.

6. **Stitch the demo GIF** (only if you captured screenshots):

   ```
   bash .sandcastle/lib/make-gif.sh
   ```

7. **Run the hard gate — do not skip and do not fake it:**

   ```
   bash .sandcastle/lib/afk-gate.sh
   ```

   This runs typecheck + unit tests and writes `.afk/gate.json`. **Never edit `.afk/gate.json`
   yourself** — the host reads it as the source of truth and refuses to merge if it's red or
   missing. If it's red, fix the real problem and re-run until green.

8. **Commit** your code changes with a clear message (do NOT commit `.afk/`). Then output
   `<promise>COMPLETE</promise>`.

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

**Scope:** bail is for when the environment blocks the **core work** — you can't install, can't
typecheck, can't run the unit tests, the repo won't build at all. It is **NOT** for when only the
**screenshot/dev-server** step is blocked — that path is handled in step 3 (skip the visual, keep
going; a green typecheck + unit gate still merges). If `afk-gate.sh` (typecheck + unit) can run and
pass, you are NOT blocked — finish normally.

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

If the failure *is* yours but you can't get the gate green (genuinely hard, underspecified issue),
still run `afk-gate.sh` so the host sees the real red verdict, write what blocked you into
`.afk/summary.md`, commit what you have, and output `<promise>COMPLETE</promise>`. The host routes
it to a human — a fine outcome, far better than faking green.
