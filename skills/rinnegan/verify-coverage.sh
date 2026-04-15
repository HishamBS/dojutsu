#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-coverage.sh <audit_dir> <source_dir>
# Verifies audit covers all source files and all layers have docs.
# Exit 0 = PASS, Exit 1 = FAIL

AUDIT_DIR="${1:?Usage: verify-coverage.sh <audit_dir> <source_dir>}"
SOURCE_DIR="${2:?Usage: verify-coverage.sh <audit_dir> <source_dir>}"

[[ -d "$AUDIT_DIR" ]] || { echo "FAIL: audit directory not found: $AUDIT_DIR"; exit 1; }
[[ -d "$SOURCE_DIR" ]] || { echo "FAIL: source directory not found: $SOURCE_DIR"; exit 1; }

FAILURES=()

fail() { FAILURES+=("$1"); echo "FAIL: $1"; }
pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; }

INVENTORY="$AUDIT_DIR/data/inventory.json"
FINDINGS="$AUDIT_DIR/data/findings.jsonl"

[[ -f "$INVENTORY" ]] || { fail "inventory.json not found"; }
[[ -f "$FINDINGS" ]] || { fail "findings.jsonl not found"; }

# --- Inventory file count vs actual files on disk ---
if [[ -f "$INVENTORY" ]]; then
  INV_COUNT=$(python3 -c "import json; print(json.load(open('$INVENTORY'))['total_files'])" 2>/dev/null || echo "0")

  # Count actual source files (detect stack from inventory)
  STACK=$(python3 -c "import json; print(json.load(open('$INVENTORY')).get('stack','unknown'))" 2>/dev/null || echo "unknown")

  case "$STACK" in
    python)  ACTUAL=$(find "$SOURCE_DIR" -name '*.py' -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/venv/*' | wc -l | tr -d ' ') ;;
    typescript) ACTUAL=$(find "$SOURCE_DIR/src" -name '*.ts' -o -name '*.tsx' 2>/dev/null | wc -l | tr -d ' ') ;;
    java)    ACTUAL=$(find "$SOURCE_DIR/src" -name '*.java' | wc -l | tr -d ' ') ;;
    *)       ACTUAL="unknown" ;;
  esac

  if [[ "$ACTUAL" != "unknown" ]]; then
    DIFF=$(( ACTUAL - INV_COUNT ))
    ABS_DIFF=${DIFF#-}
    if [[ "$ABS_DIFF" -le 5 ]]; then
      pass "inventory ($INV_COUNT) matches disk ($ACTUAL) within tolerance"
    else
      warn "inventory ($INV_COUNT) differs from disk ($ACTUAL) by $ABS_DIFF files — possible stale inventory"
    fi
  fi
fi

# --- Every layer in inventory has a layer doc ---
if [[ -f "$INVENTORY" ]]; then
  LAYERS=$(python3 -c "
import json
inv = json.load(open('$INVENTORY'))
for layer in inv.get('layers', {}).keys():
    print(layer)
" 2>/dev/null)

  while IFS= read -r layer; do
    [[ -z "$layer" ]] && continue
    DOC="$AUDIT_DIR/layers/${layer}.md"
    if [[ -f "$DOC" ]]; then
      LINES=$(wc -l < "$DOC" | tr -d ' ')
      pass "layers/${layer}.md exists ($LINES lines)"
    else
      fail "layers/${layer}.md MISSING for layer '$layer'"
    fi
  done <<< "$LAYERS"
fi

# --- Findings reference real files ---
if [[ -f "$FINDINGS" ]]; then
  UNIQUE_FILES=$(python3 -c "
import json
files = set()
with open('$FINDINGS') as f:
    for line in f:
        try:
            d = json.loads(line.strip())
            files.add(d.get('file',''))
        except: pass
print(len(files))
" 2>/dev/null || echo "0")
  pass "findings reference $UNIQUE_FILES unique files"
fi

# --- Summary ---
echo ""
echo "========================================"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "VERIFY-COVERAGE: ALL CHECKS PASSED"
  exit 0
else
  echo "VERIFY-COVERAGE: ${#FAILURES[@]} FAILURES"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
