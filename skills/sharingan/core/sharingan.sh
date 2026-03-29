#!/usr/bin/env bash
# Sharingan — Master Orchestrator
# Agent-agnostic entry point for the evidence-based QA pipeline.
#
# Usage:
#   sharingan.sh <subcommand> [args]
#
# Subcommands:
#   gate0 [base]              Run Gate 0: Deterministic Build
#   evidence [sample-size]    Spot-check evidence file hashes
#   independent --plan <f>    Run Gate 3: Independent Verification
#   runtime --plan <f>        Run Gate 4: Runtime Verification
#   reconcile [base]          Run Gate 5: Reconciliation + Verdict
#   enforce                   Run stop hook (8 phases)
#   clean                     Remove all cache files for current project
#   status                    Show pipeline state for current project
#
# Environment:
#   SHARINGAN_BASE              Base commit (default: HEAD~1)
#   SHARINGAN_CACHE_DIR         Cache directory (default: ~/.cache/sharingan)
#   SHARINGAN_VERIFIER_ENGINE   Verifier engine override (SSOT: agent-capabilities.yaml, fallback: codex)
#   SHARINGAN_VERIFIER_MODEL    Verifier model override (SSOT: agent-capabilities.yaml)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBCOMMAND="${1:-help}"
shift || true

# Common project hash computation (SHA-256, 16 chars)
_project_hash() {
  echo -n "$PWD" | shasum -a 256 | cut -c1-16
}

case "$SUBCOMMAND" in
  gate0)
    exec bash "$SCRIPT_DIR/verify-deterministic.sh" "$@"
    ;;
  evidence)
    exec bash "$SCRIPT_DIR/verify-evidence.sh" "$@"
    ;;
  independent)
    exec bash "$SCRIPT_DIR/verify-independent.sh" "$@"
    ;;
  runtime)
    exec bash "$SCRIPT_DIR/verify-runtime.sh" "$@"
    ;;
  reconcile)
    exec bash "$SCRIPT_DIR/reconcile.sh" "$@"
    ;;
  enforce)
    exec bash "$SCRIPT_DIR/enforce.sh" "$@"
    ;;
  clean)
    CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
    PROJECT_HASH=$(_project_hash)
    echo "Cleaning sharingan cache for project hash: $PROJECT_HASH"
    rm -f "${CACHE_DIR}/verdict-${PROJECT_HASH}.json"
    rm -f "${CACHE_DIR}/evidence-${PROJECT_HASH}.jsonl"
    rm -f "${CACHE_DIR}/independent-review-${PROJECT_HASH}.json"
    rm -f "${CACHE_DIR}/runtime-check-${PROJECT_HASH}.json"
    rm -f "${CACHE_DIR}/requirements-${PROJECT_HASH}.json"
    rm -f "${CACHE_DIR}/pipeline-state-${PROJECT_HASH}.json"
    rm -rf "${CACHE_DIR}/evidence-${PROJECT_HASH}/"
    echo "Done."
    ;;
  status)
    CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
    PROJECT_HASH=$(_project_hash)
    echo "Sharingan — Pipeline Status"
    echo "Project: $PWD"
    echo "Hash: $PROJECT_HASH"
    echo ""
    for artifact in \
      "verdict-${PROJECT_HASH}.json:Verdict" \
      "evidence-${PROJECT_HASH}.jsonl:Evidence" \
      "requirements-${PROJECT_HASH}.json:Requirements" \
      "independent-review-${PROJECT_HASH}.json:Independent Review" \
      "runtime-check-${PROJECT_HASH}.json:Runtime Check" \
      "pipeline-state-${PROJECT_HASH}.json:Pipeline State"; do
      FILE="${artifact%%:*}"
      LABEL="${artifact#*:}"
      FULL_PATH="${CACHE_DIR}/${FILE}"
      if [[ -f "$FULL_PATH" ]]; then
        SIZE=$(wc -c < "$FULL_PATH" | tr -d ' ')
        MTIME=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$FULL_PATH" 2>/dev/null || stat -c '%y' "$FULL_PATH" 2>/dev/null | cut -d. -f1 || echo "?")
        echo "  [OK] ${LABEL}: ${SIZE}B (${MTIME})"
      else
        echo "  [--] ${LABEL}: not found"
      fi
    done
    EVIDENCE_DIR="${CACHE_DIR}/evidence-${PROJECT_HASH}"
    if [[ -d "$EVIDENCE_DIR" ]]; then
      FILE_COUNT=$(ls "$EVIDENCE_DIR" 2>/dev/null | wc -l | tr -d ' ')
      echo "  [OK] Evidence Dir: ${FILE_COUNT} files"
    else
      echo "  [--] Evidence Dir: not found"
    fi
    # Show verdict if exists
    if [[ -f "${CACHE_DIR}/verdict-${PROJECT_HASH}.json" ]]; then
      echo ""
      VERDICT=$(python3 -c "import json,sys; v=json.load(open(sys.argv[1])); print(f\"Verdict: {v['verdict']} (v{v.get('version','?')}) at {v.get('timestamp','?')}\")" "${CACHE_DIR}/verdict-${PROJECT_HASH}.json" 2>/dev/null || echo "Verdict: (parse error)")
      echo "  $VERDICT"
    fi
    ;;
  help|--help|-h)
    echo "Sharingan — Evidence-Based QA Pipeline"
    echo ""
    echo "Usage: sharingan.sh <subcommand> [args]"
    echo ""
    echo "Subcommands:"
    echo "  gate0 [base]       Run Gate 0: Deterministic Build"
    echo "  evidence [size]    Spot-check evidence file hashes"
    echo "  independent        Run Gate 3: Independent Verification"
    echo "  runtime            Run Gate 4: Runtime Verification"
    echo "  reconcile [base]   Run Gate 5: Reconciliation + Verdict"
    echo "  enforce            Run stop hook (8 phases)"
    echo "  clean              Remove cache files for current project"
    echo "  status             Show pipeline state"
    echo "  help               Show this help"
    echo ""
    echo "Environment variables:"
    echo "  SHARINGAN_BASE              Base commit (default: HEAD~1)"
    echo "  SHARINGAN_CACHE_DIR         Cache dir (default: ~/.cache/sharingan)"
    echo "  SHARINGAN_VERIFIER_ENGINE   Verifier engine override (SSOT default: codex)"
    echo "  SHARINGAN_VERIFIER_MODEL    Verifier model override (SSOT default: gpt-5.4)"
    ;;
  *)
    echo "Unknown subcommand: $SUBCOMMAND" >&2
    echo "Run 'sharingan.sh help' for usage." >&2
    exit 1
    ;;
esac
