#!/usr/bin/env bash
set -euo pipefail

# Usage: track-progress.sh <audit_dir>
# Reads all phase JSONs, outputs summary table.

AUDIT_DIR="${1:?Usage: track-progress.sh <audit_dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[[ -n "$BUN_BIN" ]] || { echo "track-progress.sh: bun is required -- install it from https://bun.sh, then re-run" >&2; exit 1; }

exec "$BUN_BIN" "$SCRIPT_DIR/scripts/helper-cli.ts" track-progress "$AUDIT_DIR"
