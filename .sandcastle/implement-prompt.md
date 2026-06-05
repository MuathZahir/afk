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
  The host handles merge, video, comment, and close after you finish.
- The `.afk/` directory is scratch for this run — **never commit it** (it's gitignored).
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

3. **If this issue changes anything a user can see in the browser**, write a Playwright spec at
   `.afk/afk.spec.ts` that drives the feature through its acceptance criteria. This is what
   produces the proof-of-work video. Keep it focused on the happy path described in the issue.
   Use `baseURL` (already configured) for navigation, e.g. `await page.goto('/')`.
   If the issue is backend-only with nothing visual, skip the spec.

4. **Self-review** your diff before gating: remove dead code, tighten names, drop redundant
   comments, make sure you didn't break adjacent behavior. Preserve functionality.

5. **Write `.afk/summary.md`** — 4–8 lines for a human who will NOT read the code:
   what you built, key decisions/trade-offs, and the files you touched.

6. **Run the gate — do not skip and do not fake it:**

   ```
   bash .sandcastle/lib/afk-gate.sh
   ```

   This runs typecheck + unit tests + (if you wrote a spec) the Playwright e2e, and writes
   `.afk/gate.json`. **Never edit `.afk/gate.json` yourself** — the host reads it as the source
   of truth and will refuse to merge if it's red or missing. If the gate is red, fix the real
   problem and re-run it until it's green.

7. **Commit** your code changes with a clear message. Then output `<promise>COMPLETE</promise>`.

# IF YOU GET STUCK

If you genuinely cannot make the gate green (flaky environment, missing context, the issue is
underspecified), still run `afk-gate.sh` so the host sees the real red verdict, write what blocked
you into `.afk/summary.md`, commit what you have, and output `<promise>COMPLETE</promise>`.
The host will route the issue to a human — that's a fine outcome, better than faking green.
