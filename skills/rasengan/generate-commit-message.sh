#!/usr/bin/env bash
set -euo pipefail

# Usage: generate-commit-message.sh <phase_tasks_json>
# Generates a commit message from phase completion stats.

PHASE_JSON="${1:?Usage: generate-commit-message.sh <phase_tasks_json>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[[ -n "$BUN_BIN" ]] || { echo "generate-commit-message.sh: bun is required -- install it from https://bun.sh, then re-run" >&2; exit 1; }

exec "$BUN_BIN" "$SCRIPT_DIR/scripts/helper-cli.ts" commit-message "$PHASE_JSON"
