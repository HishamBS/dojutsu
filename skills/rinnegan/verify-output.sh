#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-output.sh <audit_dir>
# Verifies structural completeness of rinnegan audit output.
# Exit 0 = PASS, Exit 1 = FAIL

AUDIT_DIR="${1:?Usage: verify-output.sh <audit_dir>}"

# Validate directory structure before running checks
REQUIRED_FILES=("master-audit.md" "data/findings.jsonl" "data/config.json" "data/phase-dag.json")
MISSING=()
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$AUDIT_DIR/$f" ]] || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "FAIL: Missing required files in $AUDIT_DIR:"
  printf "  - %s\n" "${MISSING[@]}"
  exit 1
fi

FAILURES=()

fail() { FAILURES+=("$1"); echo "FAIL: $1"; }
pass() { echo "PASS: $1"; }

# --- Required files ---
for f in master-audit.md progress.md agent-instructions.md cross-cutting.md; do
  [[ -f "$AUDIT_DIR/$f" ]] && pass "$f exists" || fail "$f missing"
done

for f in data/findings.jsonl data/inventory.json data/config.json data/phase-dag.json; do
  [[ -f "$AUDIT_DIR/$f" ]] && pass "$f exists" || fail "$f missing"
done

[[ -d "$AUDIT_DIR/layers" ]] && pass "layers/ directory exists" || fail "layers/ directory missing"
[[ -d "$AUDIT_DIR/phases" ]] && pass "phases/ directory exists" || fail "phases/ directory missing"
[[ -d "$AUDIT_DIR/data/tasks" ]] && pass "data/tasks/ directory exists" || fail "data/tasks/ directory missing"

# --- Layer docs exist ---
LAYER_COUNT=$(find "$AUDIT_DIR/layers" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[[ "$LAYER_COUNT" -ge 1 ]] && pass "layers/ has $LAYER_COUNT docs" || fail "layers/ has 0 docs"

# --- Config.json readable ---
if [[ -f "$AUDIT_DIR/data/config.json" ]]; then
  TOTAL_LOC=$(python3 -c "import json; print(json.load(open('$AUDIT_DIR/data/config.json'))['total_loc'])" 2>/dev/null || echo "0")
  TOTAL_FINDINGS=$(python3 -c "import json; print(json.load(open('$AUDIT_DIR/data/config.json'))['total_findings'])" 2>/dev/null || echo "0")
  pass "config.json readable: ${TOTAL_LOC} LOC, ${TOTAL_FINDINGS} findings"
else
  TOTAL_LOC=0
  TOTAL_FINDINGS=0
  fail "config.json not readable"
fi

# --- Master-audit size (hub: 300-500 lines) ---
if [[ -f "$AUDIT_DIR/master-audit.md" ]]; then
  HUB_LINES=$(wc -l < "$AUDIT_DIR/master-audit.md" | tr -d ' ')
  if [[ "$HUB_LINES" -ge 200 ]] && [[ "$HUB_LINES" -le 800 ]]; then
    pass "master-audit.md is $HUB_LINES lines (hub range)"
  else
    fail "master-audit.md is $HUB_LINES lines (expected 200-800 for hub)"
  fi
fi

# --- Layer docs total size >= 20 * (total_loc / 1000) ---
if [[ "$TOTAL_LOC" -gt 0 ]] && [[ -d "$AUDIT_DIR/layers" ]]; then
  LAYER_TOTAL_LINES=$(cat "$AUDIT_DIR/layers"/*.md 2>/dev/null | wc -l | tr -d ' ')
  MIN_LINES=$(( TOTAL_LOC * 20 / 1000 ))
  if [[ "$LAYER_TOTAL_LINES" -ge "$MIN_LINES" ]]; then
    pass "layer docs total: $LAYER_TOTAL_LINES lines (min: $MIN_LINES)"
  else
    fail "layer docs total: $LAYER_TOTAL_LINES lines (BELOW min: $MIN_LINES)"
  fi
fi

# Per-layer minimum: >= 20 * (layer_loc / 1000) lines
for layer_doc in "$AUDIT_DIR/layers/"*-audit.md; do
  [[ -f "$layer_doc" ]] || continue
  LAYER_NAME=$(basename "$layer_doc" | sed 's/-audit\.md$//')
  LAYER_LOC=$(python3 -c "import json; inv=json.load(open('$AUDIT_DIR/data/inventory.json')); print(inv.get('layers',{}).get('$LAYER_NAME',{}).get('loc',0))" 2>/dev/null || echo 0)
  LAYER_LINES=$(wc -l < "$layer_doc" | tr -d ' ')
  MIN_LINES=$(( LAYER_LOC * 20 / 1000 ))
  if [[ $MIN_LINES -gt 0 ]] && [[ "$LAYER_LINES" -lt "$MIN_LINES" ]]; then
    fail "$layer_doc has $LAYER_LINES lines, minimum is $MIN_LINES (layer LOC: $LAYER_LOC)"
  fi
done

# --- findings.jsonl line count matches config ---
if [[ -f "$AUDIT_DIR/data/findings.jsonl" ]] && [[ "$TOTAL_FINDINGS" -gt 0 ]]; then
  JSONL_LINES=$(wc -l < "$AUDIT_DIR/data/findings.jsonl" | tr -d ' ')
  if [[ "$JSONL_LINES" -eq "$TOTAL_FINDINGS" ]]; then
    pass "findings.jsonl: $JSONL_LINES lines matches config ($TOTAL_FINDINGS)"
  else
    fail "findings.jsonl: $JSONL_LINES lines != config ($TOTAL_FINDINGS)"
  fi
fi

# --- No {{PLACEHOLDER}} strings ---
PLACEHOLDER_COUNT=$(grep -r '{{' "$AUDIT_DIR" --include='*.md' --include='*.json' 2>/dev/null | grep -v 'node_modules' | wc -l | tr -d ' ')
if [[ "$PLACEHOLDER_COUNT" -eq 0 ]]; then
  pass "no {{PLACEHOLDER}} strings found"
else
  fail "$PLACEHOLDER_COUNT {{PLACEHOLDER}} strings found in output"
fi

# --- Summary ---
echo ""
echo "========================================"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "VERIFY-OUTPUT: ALL CHECKS PASSED"
  exit 0
else
  echo "VERIFY-OUTPUT: ${#FAILURES[@]} FAILURES"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
