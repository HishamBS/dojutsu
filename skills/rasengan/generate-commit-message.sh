#!/usr/bin/env bash
set -euo pipefail

# Usage: generate-commit-message.sh <phase_tasks_json>
# Generates a commit message from phase completion stats.

PHASE_JSON="${1:?Usage: generate-commit-message.sh <phase_tasks_json>}"

[[ -f "$PHASE_JSON" ]] || { echo "fix: phase completion"; exit 0; }

# Validate JSON has required fields
python3 -c "
import json, sys
d = json.load(open('$PHASE_JSON'))
for field in ('phase', 'phase_name', 'tasks'):
    if field not in d:
        print(f'WARN: missing field {field}', file=sys.stderr)
        sys.exit(1)
" 2>/dev/null || { echo "fix: phase completion (malformed JSON)"; exit 0; }

STATS=$(python3 -c "
import json, sys
d = json.load(open('$PHASE_JSON'))
phase = d.get('phase', '?')
name = d.get('phase_name', 'unknown')
tasks = d.get('tasks', [])
applied = sum(1 for t in tasks if t.get('resolution') == 'applied')
shifted = sum(1 for t in tasks if t.get('resolution') == 'line-shifted')
resolved = sum(1 for t in tasks if t.get('resolution') == 'already_resolved')
skipped = sum(1 for t in tasks if t.get('resolution') == 'skipped')
failed = sum(1 for t in tasks if t.get('resolution') == 'failed')
parts = []
if applied: parts.append(f'{applied} applied')
if shifted: parts.append(f'{shifted} line-shifted')
if resolved: parts.append(f'{resolved} already-resolved')
if skipped: parts.append(f'{skipped} skipped')
if failed: parts.append(f'{failed} failed')
detail = ', '.join(parts) if parts else 'no changes'
print(f'fix(phase-{phase}): {name} - {detail}')
" 2>/dev/null || echo "fix: phase completion")

echo "$STATS"
