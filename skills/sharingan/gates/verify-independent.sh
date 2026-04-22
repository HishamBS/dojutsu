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
AGENT_CAPS="${HOME}/.config/spsm/policy/agent-capabilities.yaml"
SSOT_ENGINE=""
SSOT_MODEL=""
if [[ -f "$AGENT_CAPS" ]]; then
  SSOT_ENGINE=$(load_capability_value "$AGENT_CAPS" engine 2>/dev/null || true)
  SSOT_MODEL=$(load_capability_value "$AGENT_CAPS" model 2>/dev/null || true)
fi

# ── Verdict-policy SSOT (schema path + rules) ──
# Gate 3 structured-output enforcement: Codex takes --output-schema <FILE>,
# Claude takes --json-schema <json-string>. Both reject non-conforming
# responses at the engine API boundary — eliminating stylistic drift
# ("could be clearer") at its source. Gemini lacks a first-class schema
# flag and falls back to prompt + post-validate.
SHARINGAN_SKILL_CONFIG_DIR="$(cd "$SCRIPT_DIR/../config" 2>/dev/null && pwd || echo "")"
VERDICT_POLICY_FILE="${SHARINGAN_SKILL_CONFIG_DIR:-}/verdict-policy.json"
GATE3_SCHEMA_FILE=""
if [[ -f "$VERDICT_POLICY_FILE" ]] && command -v jq >/dev/null 2>&1; then
  schema_rel=$(jq -r '.schema_path // empty' "$VERDICT_POLICY_FILE" 2>/dev/null || true)
  if [[ -n "$schema_rel" ]]; then
    candidate="$SCRIPT_DIR/../$schema_rel"
    if [[ -f "$candidate" ]]; then
      GATE3_SCHEMA_FILE="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    fi
  fi
fi

gate3_schema_matches_prompt_contract() {
  local schema_file="$1"
  [[ -n "$schema_file" && -f "$schema_file" ]] || return 1

  python3 - "$schema_file" <<'PY'
import json
import sys
from pathlib import Path

schema_path = Path(sys.argv[1])
schema = json.loads(schema_path.read_text())
properties = schema.get("properties", {})
requirements = properties.get("requirements", {})
summary = properties.get("summary", {})
items = requirements.get("items", {})

if "oneOf" in items:
    raise SystemExit(1)

if requirements.get("type") != "array":
    raise SystemExit(1)

if items.get("type") != "object":
    raise SystemExit(1)

item_properties = items.get("properties", {})
required = set(items.get("required", []))
expected_item_fields = {"req_id", "description", "rating", "evidence", "language", "shell_checklist"}
if not expected_item_fields.issubset(item_properties) or not {"req_id", "description", "rating", "evidence"}.issubset(required):
    raise SystemExit(1)

if summary.get("type") != "object":
    raise SystemExit(1)

summary_properties = summary.get("properties", {})
if not {"implemented", "partial", "shell", "missing"}.issubset(summary_properties):
    raise SystemExit(1)

raise SystemExit(0)
PY
}

gate3_schema_flag_supported() {
  local schema_file="$1"
  gate3_schema_matches_prompt_contract "$schema_file"
}

process_command() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  ps -o command= -p "$pid" 2>/dev/null | head -n 1
}

detect_current_harness() {
  local self_command=""
  local parent_pid=""
  local parent_command=""

  if [[ -n "${CODEX_THREAD_ID:-}" || -n "${CODEX_CI:-}" ]]; then
    echo "codex"
    return
  fi

  if [[ -n "${CODEX_COMPANION_SESSION_ID:-}" || -n "${CLAUDE_PLUGIN_DATA:-}" || -n "${CLAUDE_ENV_FILE:-}" || -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    echo "claude"
    return
  fi

  self_command=$(process_command "$$")
  parent_pid=$(ps -o ppid= -p $$ 2>/dev/null | tr -d '[:space:]')
  parent_command=$(process_command "$parent_pid")

  if [[ "$self_command $parent_command" =~ (^|[[:space:]/])codex([[:space:]]|$) ]]; then
    echo "codex"
    return
  fi

  if [[ "$self_command $parent_command" =~ (^|[[:space:]/])claude([[:space:]]|$) ]]; then
    echo "claude"
    return
  fi

  echo "unknown"
}

choose_default_engine() {
  local current_harness="$1"

  case "$current_harness" in
    codex)
      if command -v claude >/dev/null 2>&1; then
        echo "claude"
        return
      fi
      ;;
    claude)
      if command -v codex >/dev/null 2>&1; then
        echo "codex"
        return
      fi
      ;;
  esac

  if [[ -n "$SSOT_ENGINE" ]]; then
    echo "$SSOT_ENGINE"
  else
    echo "codex"
  fi
}

choose_fallback_engine() {
  local current_harness="$1"
  local attempted_engine="$2"

  case "$current_harness" in
    codex)
      if [[ "$attempted_engine" != "codex" ]] && command -v codex >/dev/null 2>&1; then
        echo "codex"
        return
      fi
      ;;
    claude)
      if [[ "$attempted_engine" != "claude" ]] && command -v claude >/dev/null 2>&1; then
        echo "claude"
        return
      fi
      ;;
  esac

  if [[ -n "$SSOT_ENGINE" && "$SSOT_ENGINE" != "$attempted_engine" ]]; then
    echo "$SSOT_ENGINE"
  fi
}

# ── Parse args ──
PLAN_FILE=""
SHARINGAN_BASE="HEAD~1"
CURRENT_HARNESS="$(detect_current_harness)"
ENGINE=""
MODEL="${SHARINGAN_VERIFIER_MODEL:-}"
TRANSPORT="${SHARINGAN_VERIFY_TRANSPORT:-direct}"
CLI_ENGINE_SET=0
CLI_MODEL_SET=0
ENGINE_SOURCE="auto"

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan) PLAN_FILE="$2"; shift 2 ;;
    --base) SHARINGAN_BASE="$2"; shift 2 ;;
    --engine) ENGINE="$2"; CLI_ENGINE_SET=1; shift 2 ;;
    --model) MODEL="$2"; CLI_MODEL_SET=1; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$TRANSPORT" in
  auto|mux|direct) ;;
  *)
    echo "ERROR: Unsupported transport '$TRANSPORT'. Expected one of: auto, mux, direct" >&2
    exit 1
    ;;
esac

if [[ $CLI_ENGINE_SET -eq 1 ]]; then
  ENGINE_SOURCE="cli"
elif [[ -n "${SHARINGAN_VERIFIER_ENGINE:-}" ]]; then
  ENGINE="${SHARINGAN_VERIFIER_ENGINE}"
  ENGINE_SOURCE="env"
else
  ENGINE="$(choose_default_engine "$CURRENT_HARNESS")"
  if [[ -n "$SSOT_ENGINE" && "$ENGINE" == "$SSOT_ENGINE" ]]; then
    ENGINE_SOURCE="ssot"
  else
    ENGINE_SOURCE="auto-opposite-harness"
  fi
fi

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

For broad branch-level requirements, use representative evidence instead of exhaustively reading every modified file.
Read every file you cite as evidence, but do not attempt a full branch review unless the requirement itself demands it.

=== SHELL DETECTION (Language-Agnostic) ===
The goal is to detect placeholder/stub code that looks complete but does nothing real.
Apply the checks relevant to the file's language:

$SHELL_CHECKLIST
=== END SHELL DETECTION ===

CRITICAL RULES:
- You MUST use the Read tool on EVERY file you cite as evidence
- A false IMPLEMENTED rating is WORSE than a false SHELL rating
- When in doubt, rate LOWER (PARTIAL or SHELL)
- 'File exists and imports look right' is NOT evidence of IMPLEMENTED
- Read the function BODIES, not just the signatures
- Apply shell detection rules for the file's language (see above)
- Do not narrate your process in the final response
- After writing the JSON file, print the same JSON object to stdout and nothing else

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
echo "Current harness: $CURRENT_HARNESS"
echo "Engine source: $ENGINE_SOURCE"
echo "Transport: $TRANSPORT"
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

run_direct_cli_once() {
  local engine="$1"
  local model="$2"
  local use_schema=0

  # Gate 3 structured-output enforcement. When GATE3_SCHEMA_FILE is set,
  # we pass it to the engine's native schema flag (engine-boundary
  # enforcement, not parse-time patching). If unset, fall back to
  # free-form output (legacy behavior).
  if gate3_schema_flag_supported "$GATE3_SCHEMA_FILE"; then
    use_schema=1
  elif [[ -n "$GATE3_SCHEMA_FILE" && -f "$GATE3_SCHEMA_FILE" ]]; then
    echo "WARN: Gate 3 schema does not match the current verifier prompt contract; skipping native schema enforcement." >&2
  fi

  case "$engine" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        local CLAUDE_ARGS=(--print)
        if [[ $use_schema -eq 1 ]]; then
          CLAUDE_ARGS+=(--output-format json --json-schema "$(cat "$GATE3_SCHEMA_FILE")")
        fi
        echo "$VERIFIER_PROMPT" | claude "${CLAUDE_ARGS[@]}" 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: claude CLI not found" >&2
        return 1
      fi
      ;;
    codex)
      if command -v codex >/dev/null 2>&1; then
        CODEX_ARGS=(exec --full-auto -C "$(pwd)")
        if [[ -n "$model" ]]; then
          CODEX_ARGS+=(-m "$model")
        fi
        if [[ $use_schema -eq 1 ]]; then
          CODEX_ARGS+=(--output-schema "$GATE3_SCHEMA_FILE")
        fi
        codex "${CODEX_ARGS[@]}" "$VERIFIER_PROMPT" 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: codex CLI not found" >&2
        return 1
      fi
      ;;
    gemini)
      if command -v gemini >/dev/null 2>&1; then
        # Gemini's CLI lacks a first-class schema flag; use JSON output
        # and rely on prompt-instructed structure + post-validate.
        GEMINI_ARGS=(--yolo -o json -p "$VERIFIER_PROMPT")
        if [[ -n "$model" ]]; then
          GEMINI_ARGS=(-m "$model" "${GEMINI_ARGS[@]}")
        fi
        gemini "${GEMINI_ARGS[@]}" 2>&1 | tee "$CLI_OUTPUT_FILE"
      else
        echo "ERROR: gemini CLI not found" >&2
        return 1
      fi
      ;;
    *)
      echo "ERROR: Unknown engine '$ENGINE' and agent-mux not available" >&2
      return 1
      ;;
  esac
}

resolve_model_for_engine() {
  local engine="$1"

  if [[ $CLI_MODEL_SET -eq 1 || -n "${SHARINGAN_VERIFIER_MODEL:-}" ]]; then
    printf '%s\n' "$MODEL"
    return
  fi

  if [[ -n "$SSOT_MODEL" && "$engine" == "${SSOT_ENGINE:-}" ]]; then
    printf '%s\n' "$SSOT_MODEL"
  else
    printf '\n'
  fi
}

run_direct_cli() {
  local selected_engine="$ENGINE"
  local selected_model="$MODEL"
  local fallback_engine=""
  local fallback_model=""

  echo "Falling back to direct CLI..."
  if run_direct_cli_once "$selected_engine" "$selected_model"; then
    ENGINE="$selected_engine"
    MODEL="$selected_model"
    return
  fi

  if [[ "$ENGINE_SOURCE" != "auto-opposite-harness" ]]; then
    exit 1
  fi

  fallback_engine="$(choose_fallback_engine "$CURRENT_HARNESS" "$selected_engine")"
  if [[ -z "$fallback_engine" ]]; then
    exit 1
  fi

  fallback_model="$(resolve_model_for_engine "$fallback_engine")"
  echo "WARN: Auto-selected verifier engine '$selected_engine' failed; retrying with '$fallback_engine'" >&2
  : > "$CLI_OUTPUT_FILE"
  rm -f "$WORK_REVIEW_FILE"

  if ! run_direct_cli_once "$fallback_engine" "$fallback_model"; then
    exit 1
  fi

  ENGINE="$fallback_engine"
  MODEL="$fallback_model"
  ENGINE_SOURCE="fallback-current-harness"
}

abort_mux_dispatch() {
  local dispatch_id="$1"
  [[ -z "$dispatch_id" ]] && return 0
  (agent-mux steer "$dispatch_id" abort >/dev/null 2>&1 || true) &
}

mux_artifact_has_review_output() {
  local artifact_dir="$1"
  [[ -n "$artifact_dir" && -d "$artifact_dir" ]] || return 1

  python3 - "$artifact_dir" <<'PY'
import json
import sys
from pathlib import Path

artifact_dir = Path(sys.argv[1])
ignored = {
    "_dispatch_ref.json",
    "events.jsonl",
    "host.pid",
    "inbox.md",
    "status.json",
    "stdin.pipe",
}

for candidate in artifact_dir.iterdir():
    if candidate.name in ignored or not candidate.is_file():
        continue
    if candidate.suffix != ".json":
        continue
    try:
        payload = json.loads(candidate.read_text())
    except Exception:
        continue
    if isinstance(payload, dict) and isinstance(payload.get("requirements"), list) and isinstance(payload.get("summary"), dict):
        raise SystemExit(0)

raise SystemExit(1)
PY
}

review_file_is_valid() {
  local candidate="$1"
  python3 - "$candidate" <<'PY'
import json, sys
from pathlib import Path

ALLOWED_RATINGS = {"IMPLEMENTED", "PARTIAL", "SHELL", "MISSING"}

def is_real_payload(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    requirements = payload.get("requirements")
    summary = payload.get("summary")
    if not isinstance(requirements, list) or not isinstance(summary, dict):
        return False

    if not requirements:
        return False

    for key in ("implemented", "partial", "shell", "missing"):
        value = summary.get(key)
        if not isinstance(value, int) or value < 0:
            return False

    for requirement in requirements:
        if not isinstance(requirement, dict):
            return False
        if not isinstance(requirement.get("req_id"), str) or not requirement["req_id"].startswith("R"):
            return False
        if requirement.get("description") in (None, "", "..."):
            return False
        if requirement.get("rating") not in ALLOWED_RATINGS:
            return False
        evidence = requirement.get("evidence")
        if not isinstance(evidence, str) or evidence.strip() == "":
            return False
        if "Specific file:line references and what you found" in evidence:
            return False

    return True

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
payload = json.loads(path.read_text())
if not is_real_payload(payload):
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
best_payload = None

def is_real_payload(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    requirements = payload.get("requirements")
    summary = payload.get("summary")
    if not isinstance(requirements, list) or not isinstance(summary, dict):
        return False

    if not requirements:
        return False

    for key in ("implemented", "partial", "shell", "missing"):
        value = summary.get(key)
        if not isinstance(value, int) or value < 0:
            return False

    for requirement in requirements:
        if not isinstance(requirement, dict):
            return False
        req_id = requirement.get("req_id")
        if not isinstance(req_id, str) or not req_id.startswith("R"):
            return False
        if requirement.get("description") in (None, "", "..."):
            return False
        if requirement.get("rating") not in {"IMPLEMENTED", "PARTIAL", "SHELL", "MISSING"}:
            return False
        evidence = requirement.get("evidence")
        if not isinstance(evidence, str) or evidence.strip() == "":
            return False
        if "Specific file:line references and what you found" in evidence:
            return False

    return True

for index, char in enumerate(text):
    if char != "{":
        continue
    try:
        payload, _ = decoder.raw_decode(text[index:])
    except json.JSONDecodeError:
        continue
    if is_real_payload(payload):
        best_payload = payload

if best_payload is None:
    raise SystemExit(1)

target.write_text(json.dumps(best_payload, indent=2) + "\n")
raise SystemExit(0)
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
  local startup_limit="${SHARINGAN_AGENT_MUX_STARTUP_SEC:-20}"
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
  local startup_checked=0

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

    if [[ $startup_checked -eq 0 && $elapsed -ge $startup_limit ]]; then
      if ! review_file_is_valid "$WORK_REVIEW_FILE" && ! mux_artifact_has_review_output "$artifact_dir"; then
        printf '%s\n' '{"status":"failed","error":"agent-mux remained in initialization without producing verifier artifacts","metadata":{"source":"mux_startup_healthcheck"}}'
        return 0
      fi
      startup_checked=1
    fi

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
if [[ "$TRANSPORT" == "direct" ]]; then
  run_direct_cli
elif command -v agent-mux >/dev/null 2>&1; then
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
  elif ! review_file_is_valid "$WORK_REVIEW_FILE" && ! mux_artifact_has_review_output "$MUX_ARTIFACT_DIR"; then
    echo "WARN: agent-mux completed without producing verifier artifacts; falling back to direct CLI" >&2
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
