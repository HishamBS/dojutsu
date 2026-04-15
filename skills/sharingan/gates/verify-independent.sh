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

load_capability_value() {
  local file="$1"
  local field="$2"

  if command -v jq >/dev/null 2>&1 && jq -e . "$file" >/dev/null 2>&1; then
    jq -r ".agents.SharinganVerifier.${field} // \"\"" "$file"
    return
  fi

  awk -v target="$field" '
    /^agents:[[:space:]]*$/ { in_agents=1; next }
    in_agents && /^[^[:space:]]/ { in_agents=0 }
    in_agents && /^[[:space:]]{2}SharinganVerifier:[[:space:]]*$/ { in_verifier=1; next }
    in_verifier && /^[[:space:]]{2}[^[:space:]]/ { in_verifier=0 }
    in_verifier && $1 == target ":" {
      value=$2
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

# ── Read engine+model from SSOT (NEVER hardcode — matches SPSM pipeline pattern) ──
# Look for agent capabilities: skill-local first, then user config, then defaults
AGENT_CAPS="${SCRIPT_DIR}/../config/agent-capabilities.yaml"
[[ ! -f "$AGENT_CAPS" ]] && AGENT_CAPS="${HOME}/.config/spsm/policy/agent-capabilities.yaml"
SSOT_ENGINE=""
SSOT_MODEL=""
if [[ -f "$AGENT_CAPS" ]]; then
  SSOT_ENGINE=$(load_capability_value "$AGENT_CAPS" engine 2>/dev/null || true)
  SSOT_MODEL=$(load_capability_value "$AGENT_CAPS" model 2>/dev/null || true)
fi

# ── Parse args ──
PLAN_FILE=""
SHARINGAN_BASE="HEAD~1"
ENGINE="${SHARINGAN_VERIFIER_ENGINE:-${SSOT_ENGINE:-codex}}"
MODEL="${SHARINGAN_VERIFIER_MODEL:-}"
CLI_ENGINE_SET=0
CLI_MODEL_SET=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan) PLAN_FILE="$2"; shift 2 ;;
    --base) SHARINGAN_BASE="$2"; shift 2 ;;
    --engine) ENGINE="$2"; CLI_ENGINE_SET=1; shift 2 ;;
    --model) MODEL="$2"; CLI_MODEL_SET=1; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ $CLI_MODEL_SET -eq 0 && -z "${SHARINGAN_VERIFIER_MODEL:-}" ]]; then
  if [[ -n "$SSOT_MODEL" && "$ENGINE" == "${SSOT_ENGINE:-}" ]]; then
    MODEL="$SSOT_MODEL"
  else
    MODEL=""
  fi
fi

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
WORK_REVIEW_DIR="$PWD/.tmp/sharingan"
WORK_REVIEW_FILE="${WORK_REVIEW_DIR}/independent-review-${PROJECT_HASH}.json"
CLI_OUTPUT_FILE="${CACHE_DIR}/independent-review-${PROJECT_HASH}.stdout.log"
mkdir -p "$CACHE_DIR" "$WORK_REVIEW_DIR"
rm -f "$REVIEW_FILE" "$WORK_REVIEW_FILE" "$CLI_OUTPUT_FILE"

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

Write your assessment as JSON to: $WORK_REVIEW_FILE

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
FILE_COUNT=$(printf '%s\n' "$MODIFIED_FILES" | awk 'NF { count++ } END { print count + 0 }')
COMPUTED_TURNS=$(( (FILE_COUNT * 2) + 20 ))
# Floor at 30, cap at 120
if [[ $COMPUTED_TURNS -lt 30 ]]; then COMPUTED_TURNS=30; fi
if [[ $COMPUTED_TURNS -gt 120 ]]; then COMPUTED_TURNS=120; fi
# Timeout scales with turns: ~5s per turn + 30s buffer
COMPUTED_TIMEOUT_SEC=$(( COMPUTED_TURNS * 5 + 30 ))
echo "Modified files: $FILE_COUNT → max-turns: $COMPUTED_TURNS, timeout: ${COMPUTED_TIMEOUT_SEC}s"

run_direct_cli() {
  echo "Falling back to direct CLI..."
  case "$ENGINE" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        echo "$VERIFIER_PROMPT" | claude --print 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: claude CLI not found" >&2
        exit 1
      fi
      ;;
    codex)
      if command -v codex >/dev/null 2>&1; then
        CODEX_ARGS=(exec --full-auto -C "$(pwd)")
        if [[ -n "$MODEL" ]]; then
          CODEX_ARGS+=(-m "$MODEL")
        fi
        codex "${CODEX_ARGS[@]}" "$VERIFIER_PROMPT" 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: codex CLI not found" >&2
        exit 1
      fi
      ;;
    gemini)
      if command -v gemini >/dev/null 2>&1; then
        GEMINI_ARGS=(--yolo -p "$VERIFIER_PROMPT")
        if [[ -n "$MODEL" ]]; then
          GEMINI_ARGS=(-m "$MODEL" "${GEMINI_ARGS[@]}")
        fi
        gemini "${GEMINI_ARGS[@]}" 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: gemini CLI not found" >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: Unknown engine '$ENGINE' and agent-mux not available" >&2
      exit 1
      ;;
  esac
}

abort_mux_dispatch() {
  local dispatch_id="$1"
  [[ -z "$dispatch_id" ]] && return 0
  (agent-mux steer "$dispatch_id" abort >/dev/null 2>&1 || true) &
}

review_file_is_valid() {
  local candidate="$1"
  python3 - "$candidate" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
payload = json.loads(path.read_text())
if not isinstance(payload, dict):
    raise SystemExit(1)
requirements = payload.get("requirements")
summary = payload.get("summary")
if not isinstance(requirements, list) or not isinstance(summary, dict):
    raise SystemExit(1)
raise SystemExit(0)
PY
}

extract_review_from_output_log() {
  local output_log="$1"
  local target_file="$2"
  python3 - "$output_log" "$target_file" <<'PY'
import json, sys
from json import JSONDecoder
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
if not source.is_file():
    raise SystemExit(1)

text = source.read_text(errors="ignore")
decoder = JSONDecoder()
for index, char in enumerate(text):
    if char != "{":
        continue
    try:
        payload, _ = decoder.raw_decode(text[index:])
    except json.JSONDecodeError:
        continue
    if isinstance(payload, dict) and isinstance(payload.get("requirements"), list) and isinstance(payload.get("summary"), dict):
        target.write_text(json.dumps(payload, indent=2) + "\n")
        raise SystemExit(0)

raise SystemExit(1)
PY
}

finalize_review_file() {
  local engine="$1"
  local model="$2"
  local source_label="workspace"
  local attempt=0

  while [[ $attempt -lt 3 ]]; do
    if review_file_is_valid "$WORK_REVIEW_FILE"; then
      break
    fi
    if [[ -f "$WORK_REVIEW_FILE" ]]; then
      sleep 1
    else
      break
    fi
    attempt=$((attempt + 1))
  done

  if ! review_file_is_valid "$WORK_REVIEW_FILE"; then
    if ! extract_review_from_output_log "$CLI_OUTPUT_FILE" "$WORK_REVIEW_FILE"; then
      echo "WARN: Could not recover verifier JSON from output log" >&2
      return 1
    fi
    source_label="stdout"
  fi

  python3 - "$WORK_REVIEW_FILE" "$REVIEW_FILE" "$engine" "${model:-unknown}" "$source_label" <<'PY'
import json, sys
from pathlib import Path

work_file = Path(sys.argv[1])
final_file = Path(sys.argv[2])
engine = sys.argv[3]
model = sys.argv[4]
source_label = sys.argv[5]

payload = json.loads(work_file.read_text())
payload["dispatch"] = {
    "engine": engine,
    "model": model,
    "source": source_label,
}
final_file.write_text(json.dumps(payload, indent=2) + "\n")
PY
}

poll_mux_result() {
  local dispatch_id="$1"
  local artifact_dir="$2"
  local wait_limit=""
  if [[ -n "${SHARINGAN_AGENT_MUX_WAIT_SEC:-}" ]]; then
    wait_limit="$SHARINGAN_AGENT_MUX_WAIT_SEC"
  else
    wait_limit=$(( COMPUTED_TIMEOUT_SEC < 45 ? COMPUTED_TIMEOUT_SEC : 45 ))
  fi
  if [[ "$wait_limit" -lt 1 ]]; then
    wait_limit=1
  fi

  local poll_interval=5
  local elapsed=0
  local mux_result=""
  local mux_state=""
  local inspect_result=""

  while [[ $elapsed -lt $wait_limit ]]; do
    mux_result=$(agent-mux result "$dispatch_id" --json --no-wait 2>/dev/null || echo "")
    mux_state=$(echo "$mux_result" | jq -r '.status // .state // ""' 2>/dev/null)

    case "$mux_state" in
      completed|failed|timed_out|cancelled)
        printf '%s\n' "$mux_result"
        return 0
        ;;
    esac

    if review_file_is_valid "$WORK_REVIEW_FILE"; then
      printf '%s\n' '{"status":"completed","metadata":{"source":"workspace_review"}}'
      return 0
    fi

    inspect_result=$(agent-mux inspect "$dispatch_id" --json 2>/dev/null || echo "")
    mux_state=$(echo "$inspect_result" | jq -r '.record.status // .meta.status // .status // ""' 2>/dev/null)
    case "$mux_state" in
      completed|failed|timed_out|cancelled)
        printf '%s\n' "$inspect_result"
        return 0
        ;;
    esac

    if [[ -n "$artifact_dir" && -f "$artifact_dir/status.json" ]]; then
      mux_state=$(jq -r '.state // ""' "$artifact_dir/status.json" 2>/dev/null || echo "")
      case "$mux_state" in
        completed|failed|timed_out|cancelled)
          printf '%s\n' '{"status":"'"$mux_state"'","metadata":{"source":"artifact_status"}}'
          return 0
          ;;
      esac
    fi

    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
  done

  return 1
}

# ── Dispatch via agent-mux if available ──
if command -v agent-mux >/dev/null 2>&1; then
  echo "Dispatching via agent-mux..."
  MUX_ARGS=(--stream --engine "$ENGINE" --effort high --cwd "$(pwd)" --max-turns "$COMPUTED_TURNS" --timeout "$COMPUTED_TIMEOUT_SEC" --async)
  if [[ -n "$MODEL" ]]; then
    MUX_ARGS+=(--model "$MODEL")
  fi
  MUX_START=$(agent-mux "${MUX_ARGS[@]}" "$VERIFIER_PROMPT" 2>/dev/null)
  MUX_EXIT=$?
  MUX_DISPATCH_ID=$(echo "$MUX_START" | jq -r '.dispatch_id // ""' 2>/dev/null)
  MUX_ARTIFACT_DIR=$(echo "$MUX_START" | jq -r '.artifact_dir // .dispatch_spec.artifact_dir // .control.artifact_dir // ""' 2>/dev/null)

  if [[ -z "$MUX_DISPATCH_ID" ]]; then
    MUX_STATUS="failed"
    MUX_ERROR=$(echo "$MUX_START" | jq -r '.error.message // .error // "missing dispatch_id"' 2>/dev/null)
  else
    MUX_RESULT=$(poll_mux_result "$MUX_DISPATCH_ID" "$MUX_ARTIFACT_DIR" || echo "")
    MUX_STATUS=$(echo "$MUX_RESULT" | jq -r '.status // .record.status // .meta.status // "failed"' 2>/dev/null)
    MUX_ERROR=$(echo "$MUX_RESULT" | jq -r '.error.message // .error // "unknown error"' 2>/dev/null)
  fi

  if [[ "$MUX_STATUS" != "completed" ]]; then
    echo "WARN: agent-mux dispatch failed (status=$MUX_STATUS): $MUX_ERROR" >&2
    abort_mux_dispatch "$MUX_DISPATCH_ID"
    run_direct_cli
  elif [[ $MUX_EXIT -ne 0 ]]; then
    echo "WARN: agent-mux exited with $MUX_EXIT" >&2
  fi
else
  echo "agent-mux not found."
  run_direct_cli
fi

if ! finalize_review_file "$ENGINE" "${MODEL:-unknown}"; then
  echo "WARN: Review file was not created at $REVIEW_FILE" >&2
  echo "The verifier agent may not have written the output file." >&2
  exit 1
fi

# ── Verify output exists ──
if review_file_is_valid "$REVIEW_FILE"; then
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
  echo "WARN: Review file was not created as valid JSON at $REVIEW_FILE" >&2
  exit 1
fi
