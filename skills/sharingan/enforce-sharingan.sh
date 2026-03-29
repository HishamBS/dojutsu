#!/usr/bin/env bash
# Sharingan enforcement hook — delegates to gates/enforce.sh
# Resolves path relative to this script, not hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/gates/enforce.sh" "$@"
