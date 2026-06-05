#!/usr/bin/env bash
#
# afk-gate.sh — the deterministic hard gate. Runs INSIDE the container.
#
# Writes .afk/gate.json with a verdict the HOST trusts, from real command exit codes —
# never the agent's word. typecheck + unit only. Visual verification is the worker's job
# (it drives the browser via the expect skill and writes .afk/e2e.json + screenshots).
#
#   { "typecheck": bool, "unit": bool, "log": "..." }
#
set -uo pipefail
CFG=.sandcastle/afk.config.json
mkdir -p .afk
LOG=.afk/gate.log
: > "$LOG"

cfg() { jq -r ".$1 // empty" "$CFG"; }

run_check() {            # run_check <command>  → 0 pass / 1 fail ; empty command = pass (skip)
  local cmd="$1"
  [ -z "$cmd" ] && return 0
  echo -e "\n===== $cmd =====" >> "$LOG"
  bash -lc "$cmd" >> "$LOG" 2>&1
}

run_check "$(cfg typecheck)"; TC=$?
run_check "$(cfg test)"; UNIT=$?

tcb() { [ "$1" -eq 0 ] && echo true || echo false; }
jq -n \
  --argjson typecheck "$(tcb $TC)" \
  --argjson unit "$(tcb $UNIT)" \
  --rawfile log "$LOG" \
  '{typecheck:$typecheck, unit:$unit, log:$log}' > .afk/gate.json

echo "afk-gate: typecheck=$(tcb $TC) unit=$(tcb $UNIT)"
[ $TC -eq 0 ] && [ $UNIT -eq 0 ]
