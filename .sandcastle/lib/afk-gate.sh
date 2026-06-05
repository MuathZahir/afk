#!/usr/bin/env bash
#
# afk-gate.sh — the deterministic verification gate. Runs INSIDE the container.
#
# Writes .afk/gate.json with a verdict the HOST trusts. The verdict comes from real
# command exit codes, never from the agent's judgement. The agent is told to run this
# and not to edit the output.
#
#   { "typecheck": bool, "unit": bool, "e2e": "pass"|"fail"|"noboot"|"skip", "log": "..." }
#
set -uo pipefail
CFG=.sandcastle/afk.config.json
mkdir -p .afk
LOG=.afk/gate.log
: > "$LOG"

cfg() { jq -r ".$1 // empty" "$CFG"; }
section() { echo -e "\n===== $1 =====" >> "$LOG"; }

run_check() {            # run_check <command>  → 0 pass / 1 fail ; "" command = pass (skip)
  local cmd="$1"
  [ -z "$cmd" ] && return 0
  section "$cmd"
  bash -lc "$cmd" >> "$LOG" 2>&1
}

# ── typecheck ─────────────────────────────────────────────────────────────────
run_check "$(cfg typecheck)"; TC=$?

# ── unit tests ────────────────────────────────────────────────────────────────
run_check "$(cfg test)"; UNIT=$?

# ── e2e + video (only if the worker wrote a spec) ─────────────────────────────
E2E="skip"
if [ -f .afk/afk.spec.ts ]; then
  section "playwright e2e"
  # Playwright's webServer (configured to use afk.config.dev + baseUrl) boots & tears down the app.
  npx playwright test -c .sandcastle/lib/playwright.afk.config.ts >> "$LOG" 2>&1
  PW=$?
  if [ $PW -eq 0 ]; then
    E2E="pass"
  elif grep -qiE "Timed out waiting .* from config.webServer|error while waiting for .* webServer|ECONNREFUSED" "$LOG"; then
    E2E="noboot"      # harness couldn't start the app — merge on tc+unit but flag it
  else
    E2E="fail"        # app booted, the flow failed — hard block
  fi
  # surface the recorded video at a stable path for the host to upload
  VID=$(find .afk/test-results -name "*.webm" 2>/dev/null | head -n1)
  [ -n "${VID:-}" ] && cp "$VID" .afk/video.webm
fi

# ── write the verdict ─────────────────────────────────────────────────────────
tcb()  { [ "$1" -eq 0 ] && echo true || echo false; }
jq -n \
  --argjson typecheck "$(tcb $TC)" \
  --argjson unit "$(tcb $UNIT)" \
  --arg e2e "$E2E" \
  --rawfile log "$LOG" \
  '{typecheck:$typecheck, unit:$unit, e2e:$e2e, log:$log}' > .afk/gate.json

echo "afk-gate: typecheck=$(tcb $TC) unit=$(tcb $UNIT) e2e=$E2E"
[ $TC -eq 0 ] && [ $UNIT -eq 0 ] && [ "$E2E" != "fail" ]
