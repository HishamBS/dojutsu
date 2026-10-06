#!/usr/bin/env bash
set -euo pipefail

AUDIT_DIR="${1:?Usage: verify-output.sh <audit_dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
[[ -n "$BUN_BIN" ]] || { echo "verify-output.sh: bun is required -- install it from https://bun.sh, then re-run" >&2; exit 1; }

exec "$BUN_BIN" "$SCRIPT_DIR/scripts/report_contract.ts" validate "$AUDIT_DIR" rinnegan
