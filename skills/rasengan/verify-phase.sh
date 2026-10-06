#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-phase.sh <phase_tasks_json>
# Extracts verification command from phase JSON, runs it, checks result.
# Exit 0 = PASS, Exit 1 = FAIL

PHASE_JSON="${1:?Usage: verify-phase.sh <phase_tasks_json>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[[ -n "$BUN_BIN" ]] || { echo "verify-phase.sh: bun is required -- install it from https://bun.sh, then re-run" >&2; exit 1; }

exec "$BUN_BIN" "$SCRIPT_DIR/scripts/helper-cli.ts" verify-phase "$PHASE_JSON"
