#!/usr/bin/env bash
# Sharingan Evidence Spot-Checker
# Agent-agnostic — works with Claude, Codex, OpenCode
#
# Usage: verify-evidence.sh [SAMPLE_SIZE]
# Reads: evidence-{PROJECT_HASH}.jsonl
# Validates: file hashes match what was recorded
#
# Exit codes:
#   0 = spot-check passed (or no evidence file)
#   1 = hash mismatch detected (evidence is stale/fabricated)

set -euo pipefail

SAMPLE_SIZE="${1:-3}"
CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
PROJECT_HASH=$(echo -n "$PWD" | shasum -a 256 | cut -c1-16)
EVIDENCE_FILE="${CACHE_DIR}/evidence-${PROJECT_HASH}.jsonl"

if [[ ! -f "$EVIDENCE_FILE" ]]; then
  echo "No evidence file found at $EVIDENCE_FILE"
  echo "Gate 1 evidence verification skipped."
  exit 0
fi

ENTRY_COUNT=$(wc -l < "$EVIDENCE_FILE" | tr -d ' ')
echo "Evidence file: $EVIDENCE_FILE ($ENTRY_COUNT entries)"
echo "Spot-checking $SAMPLE_SIZE random VERIFIED entries..."

export EVIDENCE_FILE

PY_EXIT=0
RESULT=$(python3 << 'PYEOF'
import json, hashlib, sys, random, os

evidence_file = os.environ.get('EVIDENCE_FILE', '')

if not evidence_file or not os.path.exists(evidence_file):
    print("NO_FILE")
    sys.exit(0)

entries = []
with open(evidence_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            if entry.get('status') == 'VERIFIED' and entry.get('content_sha256') and entry.get('file'):
                entries.append(entry)
        except json.JSONDecodeError:
            continue

if not entries:
    print("NO_VERIFIED_ENTRIES")
    sys.exit(0)

# Adaptive sampling schedule:
#   <= 20 entries: check ALL (100% detection)
#   21-100 entries: check 10
#   > 100 entries: check 20
total = len(entries)
if total <= 20:
    sample_size = total
elif total <= 100:
    sample_size = 10
else:
    sample_size = 20

sample = random.sample(entries, min(sample_size, total))
failures = []
checked = 0

for e in sample:
    filepath = e['file']
    expected_hash = e['content_sha256']
    req_id = e.get('req_id', '?')
    checked += 1

    if not os.path.exists(filepath):
        failures.append(f"  {req_id}: {filepath} -- FILE NOT FOUND")
        continue

    try:
        with open(filepath, 'rb') as fh:
            actual_hash = hashlib.sha256(fh.read()).hexdigest()
    except Exception as ex:
        failures.append(f"  {req_id}: {filepath} -- READ ERROR: {ex}")
        continue

    if actual_hash != expected_hash:
        failures.append(f"  {req_id}: {filepath} -- HASH MISMATCH (file modified after verification)")
    else:
        print(f"  {req_id}: {filepath} -- OK (hash matches)")

if failures:
    print("SPOT_CHECK_FAILED")
    for f in failures:
        print(f)
    sys.exit(1)
else:
    print(f"SPOT_CHECK_PASSED ({checked}/{total} entries verified)")
    sys.exit(0)
PYEOF
) || PY_EXIT=$?

echo "$RESULT"

if echo "$RESULT" | grep -q "SPOT_CHECK_FAILED"; then
  exit 1
else
  exit 0
fi
