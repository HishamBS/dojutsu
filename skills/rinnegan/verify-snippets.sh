#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-snippets.sh <audit_dir> <source_dir>
# Spot-checks findings against actual source code.
# Exit 0 = PASS (<=20% invalid), Exit 1 = FAIL (>20% invalid)

AUDIT_DIR="${1:?Usage: verify-snippets.sh <audit_dir> <source_dir>}"
SOURCE_DIR="${2:?Usage: verify-snippets.sh <audit_dir> <source_dir>}"
FINDINGS_FILE="$AUDIT_DIR/data/findings.jsonl"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[[ -n "$BUN_BIN" ]] || { echo "verify-snippets.sh: bun is required -- install it from https://bun.sh, then re-run" >&2; exit 1; }
helper() { "$BUN_BIN" "$SCRIPT_DIR/scripts/helper-cli.ts" "$@"; }

[[ -d "$AUDIT_DIR" ]] || { echo "FAIL: audit directory not found: $AUDIT_DIR"; exit 1; }
[[ -d "$SOURCE_DIR" ]] || { echo "FAIL: source directory not found: $SOURCE_DIR"; exit 1; }
[[ -f "$FINDINGS_FILE" ]] || { echo "FAIL: $FINDINGS_FILE not found"; exit 1; }

TOTAL=$(wc -l < "$FINDINGS_FILE" | tr -d ' ')
SAMPLE_SIZE=$(( TOTAL / 10 ))
(( SAMPLE_SIZE < 10 )) && SAMPLE_SIZE=10
(( SAMPLE_SIZE > 50 )) && SAMPLE_SIZE=50
(( SAMPLE_SIZE > TOTAL )) && SAMPLE_SIZE=$TOTAL

echo "Spot-checking $SAMPLE_SIZE of $TOTAL findings..."

TMPFILE=$(mktemp)
FIELDS_FILE=$(mktemp)
trap "rm -f $TMPFILE $FIELDS_FILE" EXIT

VALID=0
INVALID=0
SKIPPED=0

# Sample random findings
helper sample-lines "$FINDINGS_FILE" "$SAMPLE_SIZE" > "$TMPFILE"

while IFS= read -r line; do
  echo "$line" | helper finding-fields file '' line 0 snippet '' id '?' > "$FIELDS_FILE" 2>/dev/null
  { IFS= read -r -d '' FILE; IFS= read -r -d '' LINE_NUM; IFS= read -r -d '' SNIPPET; IFS= read -r -d '' ID; } < "$FIELDS_FILE"

  if [[ -z "$FILE" ]] || [[ -z "$SNIPPET" ]] || [[ "$LINE_NUM" == "0" ]]; then
    echo "  SKIP: $ID — missing fields"
    ((SKIPPED++)) || true
    continue
  fi

  FULL_PATH="$SOURCE_DIR/$FILE"
  if [[ ! -f "$FULL_PATH" ]]; then
    echo "  INVALID: $ID — file not found: $FILE"
    ((INVALID++)) || true
    continue
  fi

  START=$(( LINE_NUM > 5 ? LINE_NUM - 5 : 1 ))
  END=$(( LINE_NUM + 5 ))
  CONTEXT=$(sed -n "${START},${END}p" "$FULL_PATH" 2>/dev/null || echo "")
  FIRST_LINE=$(echo "$SNIPPET" | head -1)

  if echo "$CONTEXT" | grep -qF "$FIRST_LINE" 2>/dev/null; then
    ((VALID++)) || true
  else
    echo "  INVALID: $ID — snippet not found near $FILE:$LINE_NUM"
    ((INVALID++)) || true
  fi
done < "$TMPFILE"

CHECKED=$((VALID + INVALID))
echo ""
echo "========================================"
echo "VERIFY-SNIPPETS: $VALID valid, $INVALID invalid, $SKIPPED skipped (of $SAMPLE_SIZE sampled)"

if [[ "$CHECKED" -eq 0 ]]; then
  echo "WARN: No findings could be checked"
  exit 0
fi

INVALID_PCT=$(( INVALID * 100 / CHECKED ))
if [[ "$INVALID_PCT" -gt 20 ]]; then
  echo "FAIL: ${INVALID_PCT}% invalid (threshold: 20%)"
  exit 1
else
  echo "PASS: ${INVALID_PCT}% invalid (within 20% threshold)"
  exit 0
fi
