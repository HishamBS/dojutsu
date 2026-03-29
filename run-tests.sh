#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Naruto Trio Test Suite ==="
echo ""

FAILED=0

echo "--- Rinnegan (63 tests) ---"
if python3 -m pytest "$SCRIPT_DIR/skills/rinnegan/tests/" -q; then
    echo ""
else
    FAILED=1
fi

echo "--- Rasengan (30 tests) ---"
if python3 -m pytest "$SCRIPT_DIR/skills/rasengan/tests/" -q --import-mode=importlib; then
    echo ""
else
    FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
    echo "=== All 93 tests passed ==="
else
    echo "=== SOME TESTS FAILED ==="
    exit 1
fi
