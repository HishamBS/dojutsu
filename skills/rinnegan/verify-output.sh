#!/usr/bin/env bash
set -euo pipefail

AUDIT_DIR="${1:?Usage: verify-output.sh <audit_dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$SCRIPT_DIR/scripts/report_contract.py" validate "$AUDIT_DIR" rinnegan
