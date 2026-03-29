#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-phase.sh <phase_tasks_json>
# Extracts verification command from phase JSON, runs it, checks result.
# Exit 0 = PASS, Exit 1 = FAIL

PHASE_JSON="${1:?Usage: verify-phase.sh <phase_tasks_json>}"

[[ -f "$PHASE_JSON" ]] || { echo "FAIL: $PHASE_JSON not found"; exit 1; }

COMMAND=$(python3 -c "import json; d=json.load(open('$PHASE_JSON')); print(d.get('verification',{}).get('command',''))" 2>/dev/null)
EXPECTED=$(python3 -c "import json; d=json.load(open('$PHASE_JSON')); print(d.get('verification',{}).get('expected',''))" 2>/dev/null)

if [[ -z "$COMMAND" ]]; then
  echo "WARN: No verification command in $PHASE_JSON"
  exit 0
fi

echo "Running: $COMMAND"
ACTUAL=$(bash -c "$COMMAND" 2>&1 | tr -d '[:space:]')
EXPECTED_CLEAN=$(echo "$EXPECTED" | tr -d '[:space:]')

if [[ "$ACTUAL" == "$EXPECTED_CLEAN" ]]; then
  echo "PASS: Expected '$EXPECTED', got '$ACTUAL'"
  exit 0
else
  echo "FAIL: Expected '$EXPECTED', got '$ACTUAL'"
  exit 1
fi
