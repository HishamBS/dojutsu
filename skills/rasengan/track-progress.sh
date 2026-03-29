#!/usr/bin/env bash
set -euo pipefail

# Usage: track-progress.sh <audit_dir>
# Reads all phase JSONs, outputs summary table.

AUDIT_DIR="${1:?Usage: track-progress.sh <audit_dir>}"
TASKS_DIR="$AUDIT_DIR/data/tasks"

[[ -d "$TASKS_DIR" ]] || { echo "No tasks directory at $TASKS_DIR"; exit 1; }

echo "Phase | Total | Pending | InProgress | Completed | Resolved | Skipped | Failed"
echo "------|-------|---------|------------|-----------|----------|---------|-------"

TOTAL_ALL=0
COMPLETED_ALL=0

for json in "$TASKS_DIR"/phase-*-tasks.json; do
  [[ -f "$json" ]] || continue
  PHASE=$(basename "$json" | sed 's/phase-\([0-9]*\)-.*/\1/')
  STATS=$(python3 -c "
import json, sys
d = json.load(open('$json'))
tasks = d.get('tasks', [])
total = len(tasks)
by_status = {}
for t in tasks:
    s = t.get('status', 'pending')
    by_status[s] = by_status.get(s, 0) + 1
by_res = {}
for t in tasks:
    r = t.get('resolution', '')
    if r:
        by_res[r] = by_res.get(r, 0) + 1
pending = by_status.get('pending', 0)
in_prog = by_status.get('in_progress', 0)
completed = by_status.get('completed', 0)
resolved = by_res.get('already_resolved', 0)
skipped = by_res.get('skipped', 0)
failed = by_res.get('failed', 0)
print(f'{total}|{pending}|{in_prog}|{completed}|{resolved}|{skipped}|{failed}')
" 2>/dev/null || echo "0|0|0|0|0|0|0")

  IFS='|' read -r TOTAL PENDING INPROG COMPLETED RESOLVED SKIPPED FAILED <<< "$STATS"
  printf "  %-5s | %-5s | %-7s | %-10s | %-9s | %-8s | %-7s | %s\n" \
    "$PHASE" "$TOTAL" "$PENDING" "$INPROG" "$COMPLETED" "$RESOLVED" "$SKIPPED" "$FAILED"
  TOTAL_ALL=$((TOTAL_ALL + TOTAL))
  COMPLETED_ALL=$((COMPLETED_ALL + COMPLETED + RESOLVED))
done

echo ""
echo "Total: $COMPLETED_ALL/$TOTAL_ALL tasks resolved"
