#!/usr/bin/env bash
# Sharingan Gate 3: Independent Cross-Engine Verification
# Language/framework-agnostic — works with any project type.
#
# Usage: verify-independent.sh --plan <plan-file> --base <commit> [--engine <codex|claude>] [--model <model-id>]
# Output: independent-review-{PROJECT_HASH}.json
#
# The verifier gets ZERO builder context. It reads the plan and code fresh.

set -euo pipefail

# ── Shared library ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib-project-types.sh"

# ── Read engine+model from SSOT (NEVER hardcode — matches SPSM pipeline pattern) ──
AGENT_CAPS="${HOME}/.config/spsm/policy/agent-capabilities.yaml"
SSOT_ENGINE=""
SSOT_MODEL=""
if [[ -f "$AGENT_CAPS" ]] && command -v jq >/dev/null 2>&1; then
  SSOT_ENGINE=$(jq -r '.agents.SharinganVerifier.engine // "codex"' "$AGENT_CAPS" 2>/dev/null)
  SSOT_MODEL=$(jq -r '.agents.SharinganVerifier.model // ""' "$AGENT_CAPS" 2>/dev/null)
fi

# ── Parse args ──
PLAN_FILE=""
SHARINGAN_BASE="HEAD~1"
ENGINE="${SHARINGAN_VERIFIER_ENGINE:-${SSOT_ENGINE:-codex}}"
MODEL="${SHARINGAN_VERIFIER_MODEL:-${SSOT_MODEL:-}}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan) PLAN_FILE="$2"; shift 2 ;;
    --base) SHARINGAN_BASE="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PLAN_FILE" ]]; then
  echo "ERROR: --plan is required" >&2
  echo "Usage: verify-independent.sh --plan <plan-file> --base <commit> [--engine <codex|claude>] [--model <model-id>]" >&2
  exit 1
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
PROJECT_HASH=$(sharingan_project_hash)
REVIEW_FILE="${CACHE_DIR}/independent-review-${PROJECT_HASH}.json"
mkdir -p "$CACHE_DIR"

# ── Get modified files ──
MODIFIED_FILES=$(git diff --name-only "$SHARINGAN_BASE" 2>/dev/null || echo "")
if [[ -z "$MODIFIED_FILES" ]]; then
  MODIFIED_FILES=$(git diff --cached --name-only 2>/dev/null || echo "")
fi

# ── Detect project types for shell-detection guidance ──
LANGUAGES=$(sharingan_detect_languages_from_files "$MODIFIED_FILES")

# ── Build shell detection checklist from shared library ──
SHELL_CHECKLIST=$(sharingan_build_shell_checklist "$LANGUAGES")

# ── Read plan content ──
PLAN_CONTENT=$(cat "$PLAN_FILE")

# ── Build verifier prompt (language-agnostic) ──
VERIFIER_PROMPT="You are an independent code verifier. You have NEVER seen this code before.
You have NO prior context about this project. Your job is to find PROBLEMS, not confirm success.

SPECIFICATION (the plan):
$PLAN_CONTENT

MODIFIED FILES:
$MODIFIED_FILES

PROJECT DIRECTORY: $PWD
DETECTED LANGUAGES: $LANGUAGES

For EACH requirement in the specification:
1. Read the relevant file using the Read tool (MANDATORY)
2. Find the implementation (or lack thereof)
3. Rate it:
   - IMPLEMENTED: Full working code with real logic, data flow, error handling
   - PARTIAL: Some logic exists but incomplete
   - SHELL: File exists but contains placeholder/minimal code
   - MISSING: No corresponding code found

=== SHELL DETECTION (Language-Agnostic) ===
The goal is to detect placeholder/stub code that looks complete but does nothing real.
Apply the checks relevant to the file's language:

$SHELL_CHECKLIST
=== END SHELL DETECTION ===

CRITICAL RULES:
- You MUST use the Read tool on EVERY file you assess
- A false IMPLEMENTED rating is WORSE than a false SHELL rating
- When in doubt, rate LOWER (PARTIAL or SHELL)
- 'File exists and imports look right' is NOT evidence of IMPLEMENTED
- Read the function BODIES, not just the signatures
- Apply shell detection rules for the file's language (see above)

Write your assessment as JSON to: $REVIEW_FILE

JSON format:
{
  \"requirements\": [
    {
      \"req_id\": \"R1\",
      \"description\": \"...\",
      \"rating\": \"IMPLEMENTED|PARTIAL|SHELL|MISSING\",
      \"evidence\": \"Specific file:line references and what you found\",
      \"language\": \"detected language of the file\",
      \"shell_checklist\": {}
    }
  ],
  \"summary\": {
    \"implemented\": 0,
    \"partial\": 0,
    \"shell\": 0,
    \"missing\": 0
  }
}"

echo "Spawning independent verifier via engine: $ENGINE, model: ${MODEL:-<default>}"
echo "Plan: $PLAN_FILE"
echo "Base: $SHARINGAN_BASE"
echo "Languages: $LANGUAGES"
echo "Output: $REVIEW_FILE"
echo ""

# ── Calculate max turns from modified file count ──
# Verification is read-heavy: each file = ~2 turns (tool call + result).
# Add buffer for plan parsing + JSON output write.
FILE_COUNT=$(echo "$MODIFIED_FILES" | grep -c '.' || echo "0")
COMPUTED_TURNS=$(( (FILE_COUNT * 2) + 20 ))
# Floor at 30, cap at 120
if [[ $COMPUTED_TURNS -lt 30 ]]; then COMPUTED_TURNS=30; fi
if [[ $COMPUTED_TURNS -gt 120 ]]; then COMPUTED_TURNS=120; fi
# Timeout scales with turns: ~5s per turn + 30s buffer
COMPUTED_TIMEOUT=$(( (COMPUTED_TURNS * 5 + 30) * 1000 ))
echo "Modified files: $FILE_COUNT → max-turns: $COMPUTED_TURNS, timeout: ${COMPUTED_TIMEOUT}ms"

# ── Dispatch via agent-mux if available ──
if command -v agent-mux >/dev/null 2>&1; then
  echo "Dispatching via agent-mux..."
  MUX_ARGS=(--engine "$ENGINE" --effort high --cwd "$(pwd)" --max-turns "$COMPUTED_TURNS" --timeout "$COMPUTED_TIMEOUT")
  if [[ -n "$MODEL" ]]; then
    MUX_ARGS+=(--model "$MODEL")
  fi
  MUX_RESULT=$(agent-mux "${MUX_ARGS[@]}" "$VERIFIER_PROMPT" 2>/dev/null)
  MUX_EXIT=$?

  # Parse JSON output contract
  MUX_SUCCESS=$(echo "$MUX_RESULT" | jq -r '.success // false' 2>/dev/null)
  MUX_COMPLETED=$(echo "$MUX_RESULT" | jq -r '.completed // false' 2>/dev/null)

  if [[ "$MUX_SUCCESS" != "true" || "$MUX_COMPLETED" != "true" ]]; then
    MUX_ERROR=$(echo "$MUX_RESULT" | jq -r '.error // "unknown error"' 2>/dev/null)
    echo "WARN: agent-mux dispatch failed (success=$MUX_SUCCESS, completed=$MUX_COMPLETED): $MUX_ERROR" >&2
  elif [[ $MUX_EXIT -ne 0 ]]; then
    echo "WARN: agent-mux exited with $MUX_EXIT" >&2
  fi
else
  # Fallback: try direct CLI invocation
  echo "agent-mux not found. Trying direct CLI..."
  case "$ENGINE" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        echo "$VERIFIER_PROMPT" | claude --print 2>&1
      else
        echo "ERROR: claude CLI not found" >&2
        exit 1
      fi
      ;;
    codex)
      if command -v codex >/dev/null 2>&1; then
        codex --quiet --full-auto "$VERIFIER_PROMPT" 2>&1
      else
        echo "ERROR: codex CLI not found" >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: Unknown engine '$ENGINE' and agent-mux not available" >&2
      exit 1
      ;;
  esac
fi

# ── Inject dispatch metadata into review file for reconcile.sh ──
if [[ -f "$REVIEW_FILE" ]] && command -v jq >/dev/null 2>&1; then
  jq --arg engine "$ENGINE" --arg model "${MODEL:-unknown}" \
    '. + {"dispatch": {"engine": $engine, "model": $model}}' \
    "$REVIEW_FILE" > "${REVIEW_FILE}.tmp" && mv "${REVIEW_FILE}.tmp" "$REVIEW_FILE"
fi

# ── Verify output exists ──
if [[ -f "$REVIEW_FILE" ]]; then
  echo ""
  echo "Independent review written to: $REVIEW_FILE"
  # Validate JSON
  if python3 -c "import json; json.load(open('$REVIEW_FILE'))" 2>/dev/null; then
    SUMMARY=$(python3 -c "
import json
d = json.load(open('$REVIEW_FILE'))
s = d.get('summary', {})
print(f\"  Implemented: {s.get('implemented', 0)}\")
print(f\"  Partial: {s.get('partial', 0)}\")
print(f\"  Shell: {s.get('shell', 0)}\")
print(f\"  Missing: {s.get('missing', 0)}\")
" 2>/dev/null)
    echo "$SUMMARY"
  else
    echo "WARN: Review file exists but is not valid JSON" >&2
  fi
else
  echo "WARN: Review file was not created at $REVIEW_FILE" >&2
  echo "The verifier agent may not have written the output file." >&2
  exit 1
fi
