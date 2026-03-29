#!/usr/bin/env bash
set -euo pipefail

# This script checks a SUBSET of engineering rules via grep patterns.
# Covered: R05 (security), R07 (typing), R09 (clean code), R13 (magic numbers)
# NOT covered (require semantic analysis): R01, R02, R03, R04, R08, R10, R11, R12, R14, R16
# Uncovered rules are checked by: mini-rinnegan scan (--scope files) and /sharingan

# Usage: verify-fix-compliance.sh <file_path> <stack>
# Checks a single modified file against engineering rules.
# Exit 0 = PASS, Exit 1 = violations found

FILE="${1:?Usage: verify-fix-compliance.sh <file_path> <stack>}"
STACK="${2:?Usage: verify-fix-compliance.sh <file_path> <stack>}"
VIOLATION_COUNT=0

fail() {
  VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
  echo "VIOLATION: $1"
}

[[ -f "$FILE" ]] || { echo "FAIL: file not found: $FILE"; exit 1; }

case "$STACK" in
  python)
    # R07: no Any in public function signatures (excluding imports and comments)
    while IFS= read -r line; do
      fail "R07: 'Any' usage at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '\bAny\b' "$FILE" 2>/dev/null | grep -v '#' | grep -v 'import' | head -5 || true)

    # R09: no banner comments
    while IFS= read -r line; do
      fail "R09: Banner comment at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '^# ===' "$FILE" 2>/dev/null | head -5 || true)

    # R05: no verify=False
    while IFS= read -r line; do
      fail "R05: verify=False at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n 'verify=False' "$FILE" 2>/dev/null | head -5 || true)

    # R05: no eval/exec
    while IFS= read -r line; do
      fail "R05: eval/exec at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '\beval(\|exec(' "$FILE" 2>/dev/null | grep -v '#' | head -5 || true)

    # R13: no magic numbers (3+ digit literals not in constants or comments)
    while IFS= read -r line; do
      fail "R13: Magic number at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '[^a-zA-Z_0-9"][0-9]\{3,\}' "$FILE" 2>/dev/null | grep -v '#' | grep -v 'import' | grep -v 'line\|port\|status_code\|0x' | head -5 || true)
    ;;

  typescript)
    # R07: no explicit 'any'
    while IFS= read -r line; do
      fail "R07: 'any' type at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '\bany\b' "$FILE" 2>/dev/null | grep -v '//' | grep -v 'import' | head -5 || true)

    # R09: no console.log in production
    while IFS= read -r line; do
      fail "R09: console statement at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n 'console\.\(log\|warn\|error\|debug\)' "$FILE" 2>/dev/null | grep -v '//' | head -5 || true)

    # R05: no dangerouslySetInnerHTML
    while IFS= read -r line; do
      fail "R05: XSS risk at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n 'dangerouslySetInnerHTML' "$FILE" 2>/dev/null | head -5 || true)

    # R05: no eval
    while IFS= read -r line; do
      fail "R05: eval at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '\beval(' "$FILE" 2>/dev/null | grep -v '//' | head -5 || true)

    # R13: no magic numbers (3+ digit literals)
    while IFS= read -r line; do
      fail "R13: Magic number at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n '[^a-zA-Z_0-9"][0-9]\{3,\}' "$FILE" 2>/dev/null | grep -v '//' | grep -v 'import\|port\|0x' | head -5 || true)
    ;;

  java)
    # R07: no raw types
    while IFS= read -r line; do
      fail "R07: Raw Map type at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n 'Map[^<]' "$FILE" 2>/dev/null | grep -v '//' | head -5 || true)

    # R09: no System.out
    while IFS= read -r line; do
      fail "R09: System.out at $FILE:$(echo "$line" | cut -d: -f1)"
    done < <(grep -n 'System\.out\.print' "$FILE" 2>/dev/null | head -5 || true)
    ;;

  *)
    echo "WARN: Unknown stack '$STACK', skipping rule checks"
    exit 0
    ;;
esac

if [[ "$VIOLATION_COUNT" -eq 0 ]]; then
  echo "PASS: $FILE complies with engineering rules"
  exit 0
else
  echo "FAIL: $VIOLATION_COUNT violation(s) in $FILE"
  exit 1
fi
