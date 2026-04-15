#!/usr/bin/env bash
# Sharingan Enforcement Hook
# Agent-agnostic — works as stop hook for Claude, Codex, OpenCode
#
# Two-mode design:
#   LIGHTWEIGHT (analysis/audit/question sessions):
#     - Type-check + stub grep only (~5 seconds)
#     - No verdict required
#   FULL (implementation sessions with commits):
#     - All phases: verdict, HMAC, commit-staleness, type-check, stubs,
#       evidence, independent review, runtime, gate numbers
#
# Mode detection:
#   COMMIT_BEFORE env var set AND HEAD != COMMIT_BEFORE → FULL mode
#   Otherwise → LIGHTWEIGHT mode
#
# Baseline comparison (prevents pre-existing errors from blocking):
#   1. No modified source files → skip type-check entirely
#   2. Modified files + baseline exists → only BLOCK if error count increased
#   3. Modified files + no baseline → capture baseline, pass this time
#
# Usage: Called as a stop hook by any coding agent
# Can also be run manually: ~/.config/spsm/sharingan/enforce.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib-project-types.sh"

CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
mkdir -p "$CACHE_DIR"
PROJECT_HASH=$(sharingan_project_hash)
VERDICT_FILE="${CACHE_DIR}/verdict-${PROJECT_HASH}.json"
EVIDENCE_FILE="${CACHE_DIR}/evidence-${PROJECT_HASH}.jsonl"
REVIEW_FILE="${CACHE_DIR}/independent-review-${PROJECT_HASH}.json"
RUNTIME_FILE="${CACHE_DIR}/runtime-check-${PROJECT_HASH}.json"
BASELINE_FILE="${CACHE_DIR}/baseline-${PROJECT_HASH}.json"

# ── Phase 0: Determine session mode ──
SESSION_MODE="LIGHTWEIGHT"

if [[ -n "${COMMIT_BEFORE:-}" ]]; then
  CURRENT_HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo "")
  if [[ -n "$CURRENT_HEAD" && "$CURRENT_HEAD" != "$COMMIT_BEFORE" ]]; then
    SESSION_MODE="FULL"
  fi
fi

if [[ "$SESSION_MODE" == "LIGHTWEIGHT" && -f "$VERDICT_FILE" ]]; then
  HAS_TRACKED_CHANGES=false
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TRACKED_CHANGED=$(git status --porcelain 2>/dev/null | { grep -v '^??' || true; } | wc -l | tr -d ' ')
    [[ "$TRACKED_CHANGED" -gt 0 ]] && HAS_TRACKED_CHANGES=true
  fi
  if [[ "$HAS_TRACKED_CHANGES" == "true" ]]; then
    VERDICT_HEAD=$(jq -r '.head_commit // ""' "$VERDICT_FILE" 2>/dev/null)
    CURRENT_HEAD_FULL=$(git rev-parse HEAD 2>/dev/null || echo "")
    if [[ -n "$VERDICT_HEAD" && "$VERDICT_HEAD" == "$CURRENT_HEAD_FULL" ]]; then
      SESSION_MODE="FULL"
    fi
  fi
fi

# ── Baseline: read error count for a language ──
baseline_read() {
  local lang="$1"
  if [[ -f "$BASELINE_FILE" ]]; then
    jq -r ".languages.\"${lang}\".error_count // -1" "$BASELINE_FILE" 2>/dev/null || echo "-1"
  else
    echo "-1"
  fi
}

# ── Baseline: write error count for a language ──
baseline_write() {
  local lang="$1"
  local count="$2"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local tmp_file="${BASELINE_FILE}.tmp"
  if [[ -f "$BASELINE_FILE" ]]; then
    jq --arg lang "$lang" --argjson count "$count" --arg ts "$now" \
      '.languages[$lang].error_count = $count | .timestamp = $ts' \
      "$BASELINE_FILE" > "$tmp_file" && mv "$tmp_file" "$BASELINE_FILE"
  else
    echo "{\"languages\":{\"${lang}\":{\"error_count\":${count}}},\"timestamp\":\"${now}\"}" | jq . > "$BASELINE_FILE"
  fi
}

# ── Type-check with baseline comparison (config-driven) ──
run_typecheck() {
  # Check for modified source files
  local MODIFIED_SOURCE
  MODIFIED_SOURCE=$(sharingan_get_all_modified_source "HEAD~1" 2>/dev/null || echo "")

  # Rule 1: No modified source files → skip type-check entirely
  if [[ -z "$MODIFIED_SOURCE" ]]; then
    return 0
  fi

  local PROJECT_TYPES
  PROJECT_TYPES=$(sharingan_detect_languages)
  [[ -z "$PROJECT_TYPES" ]] && return 0

  for lang in $PROJECT_TYPES; do
    local tc_log
    tc_log=$(mktemp "${TMPDIR:-/tmp}/sharingan-tc.XXXXXX")
    local tc_exit=0
    sharingan_run_typecheck "$lang" "$tc_log" || tc_exit=$?

    if [[ "$SHARINGAN_TC_SKIPPED" == "true" ]]; then
      rm -f "$tc_log"
      continue
    fi

    if [[ $tc_exit -ne 0 ]]; then
      local current_errors
      current_errors=$(wc -l < "$tc_log" | tr -d ' ')

      # Rule 2: Baseline exists → delta comparison
      local baseline_errors
      baseline_errors=$(baseline_read "$lang")

      if [[ "$baseline_errors" -ge 0 ]]; then
        if [[ $current_errors -le $baseline_errors ]]; then
          rm -f "$tc_log"
          continue
        fi
        local new_errors=$((current_errors - baseline_errors))
        echo "BLOCKED: ${SHARINGAN_TC_DESC} — $new_errors new error(s) (baseline: $baseline_errors, now: $current_errors)." >&2
        rm -f "$tc_log"
        return 1
      fi

      # Rule 3: No baseline → capture it and pass
      baseline_write "$lang" "$current_errors"
      rm -f "$tc_log"
      continue
    fi

    # Type-check passed → update baseline to 0
    baseline_write "$lang" 0
    rm -f "$tc_log"
  done

  return 0
}

# ── Placeholder-marker + unsafe type check (config-driven) ──
run_stub_check() {
  local MODIFIED_FILES
  MODIFIED_FILES=$(sharingan_get_all_modified_source "HEAD~1" 2>/dev/null || echo "")
  [[ -z "$MODIFIED_FILES" ]] && return 0

  # Placeholder-marker detection
  local STUB_PATTERN
  STUB_PATTERN=$(sharingan_get_stub_pattern)
  local STUB_HITS=""
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    local HITS
    HITS=$(grep -nHE "$STUB_PATTERN" "$f" 2>/dev/null || true)
    [[ -n "$HITS" ]] && STUB_HITS="${STUB_HITS}${HITS}"$'\n'
  done <<< "$MODIFIED_FILES"

  if [[ -n "$(echo "$STUB_HITS" | grep -v '^$')" ]]; then
    echo "BLOCKED: Placeholder markers found in modified files:" >&2
    echo "$STUB_HITS" | grep -v '^$' | head -10 >&2
    return 1
  fi

  # Unsafe type detection per language
  local PROJECT_TYPES
  PROJECT_TYPES=$(sharingan_detect_languages)

  for lang in $PROJECT_TYPES; do
    local patterns
    patterns=$(sharingan_get_unsafe_patterns "$lang")
    [[ -z "$patterns" ]] && continue

    local exts
    exts=$(sharingan_get_extensions "$lang")
    local lang_files=""
    for ext in $exts; do
      lang_files="${lang_files}$(sharingan_get_modified_files "$ext" "HEAD~1")"$'\n'
    done
    lang_files=$(echo "$lang_files" | sort -u | grep -v '^$')
    [[ -z "$lang_files" ]] && continue

    # Combine patterns into single regex
    local combined_pattern
    combined_pattern=$(echo "$patterns" | paste -sd'|' -)

    local UNSAFE_HITS=""
    while IFS= read -r f; do
      [[ -f "$f" ]] || continue
      local HITS
      HITS=$(grep -nHE "$combined_pattern" "$f" 2>/dev/null || true)
      [[ -n "$HITS" ]] && UNSAFE_HITS="${UNSAFE_HITS}${HITS}"$'\n'
    done <<< "$lang_files"

    if [[ -n "$(echo "$UNSAFE_HITS" | grep -v '^$')" ]]; then
      echo "BLOCKED: Unsafe type usage in $lang files:" >&2
      echo "$UNSAFE_HITS" | grep -v '^$' | head -10 >&2
      return 1
    fi
  done

  return 0
}

# ══════════════════════════════════════════════════════════════
# LIGHTWEIGHT MODE — analysis/audit/question sessions
# ══════════════════════════════════════════════════════════════

if [[ "$SESSION_MODE" == "LIGHTWEIGHT" ]]; then
  HAS_CHANGES=false
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    CHANGED=$(git status --porcelain 2>/dev/null | { grep -v '^??' || true; } | wc -l | tr -d ' ')
    [[ "$CHANGED" -gt 0 ]] && HAS_CHANGES=true
  fi

  if [[ "$HAS_CHANGES" == "false" ]]; then
    exit 0
  fi

  echo "" >&2

  if ! run_typecheck; then
    echo "" >&2
    exit 1
  fi

  # Stub check skipped in LIGHTWEIGHT mode — pre-existing working tree
  # dirt is not this session's problem. FULL mode (Phase F5) catches
  # unfinished follow-up markers when actual implementation commits exist.

  exit 0
fi

# ══════════════════════════════════════════════════════════════
# FULL MODE — implementation sessions (COMMIT_BEFORE set + HEAD moved)
# ══════════════════════════════════════════════════════════════

echo "" >&2

# ── Phase F1: Verdict file must exist and be CLEAR ──
if [[ ! -f "$VERDICT_FILE" ]]; then
  echo "BLOCKED: No sharingan verdict found (Phase F1)." >&2
  echo "Run /sharingan after implementation to verify completeness." >&2
  echo "" >&2
  exit 1
fi

VERDICT=$(jq -r '.verdict // "UNKNOWN"' "$VERDICT_FILE" 2>/dev/null)
if [[ "$VERDICT" != "CLEAR" ]]; then
  echo "BLOCKED: Sharingan verdict is ${VERDICT}, not CLEAR (Phase F1)." >&2
  echo "Run /sharingan to resolve issues." >&2
  echo "" >&2
  exit 1
fi

# ── Phase F2: HMAC integrity ──
export SCRIPT_DIR PROJECT_HASH
HMAC_CHECK=$(python3 -c "
import json, hashlib, sys, os
import hmac as hmac_mod
from pathlib import Path

verdict = json.load(open(sys.argv[1]))
project_hash = os.environ.get('PROJECT_HASH', 'default')

keyfile = Path.home() / '.config' / 'spsm' / '.hmac-key'
if keyfile.exists():
    hmac_key = keyfile.read_bytes().strip()
else:
    hmac_key = hashlib.sha256(('sharingan-' + project_hash).encode()).digest()

sign_payload = json.dumps(verdict.get('gates', {}), sort_keys=True) + '|' + verdict.get('timestamp', '')
expected = hmac_mod.new(hmac_key, sign_payload.encode(), hashlib.sha256).hexdigest()
actual = verdict.get('hmac', '')

if not actual:
    print('HMAC_MISSING')
    sys.exit(0)

if not hmac_mod.compare_digest(expected, actual):
    print('HMAC_FAIL')
    sys.exit(0)

print('OK')
" "$VERDICT_FILE" 2>/dev/null) || {
  echo "BLOCKED: Verdict HMAC verification failed (Phase F2)." >&2
  echo "Verdict file may be corrupted or Python encountered an error." >&2
  echo "" >&2
  exit 1
}

if [[ "$HMAC_CHECK" == "HMAC_FAIL" ]]; then
  echo "BLOCKED: Verdict HMAC signature invalid (Phase F2)." >&2
  echo "Verdict was not produced by reconcile.sh — possible forgery." >&2
  echo "" >&2
  exit 1
fi
if [[ "$HMAC_CHECK" == "HMAC_MISSING" ]]; then
  echo "BLOCKED: Verdict has no HMAC signature (Phase F2)." >&2
  echo "Re-run /sharingan to produce a signed verdict." >&2
  echo "" >&2
  exit 1
fi

# ── Phase F3: Commit-based staleness ──
CURRENT_HEAD_FULL=$(git rev-parse HEAD 2>/dev/null || echo "")
VERDICT_HEAD=$(jq -r '.head_commit // ""' "$VERDICT_FILE" 2>/dev/null)
if [[ -n "$CURRENT_HEAD_FULL" && -n "$VERDICT_HEAD" && "$CURRENT_HEAD_FULL" != "$VERDICT_HEAD" ]]; then
  echo "BLOCKED: Verdict covers commit ${VERDICT_HEAD:0:8} but HEAD is ${CURRENT_HEAD_FULL:0:8} (Phase F3)." >&2
  echo "Code changed after /sharingan ran. Re-run /sharingan." >&2
  echo "" >&2
  exit 1
fi

# ── Phase F4: DETERMINISTIC — type-check (with baseline comparison) ──
if ! run_typecheck; then
  echo "Phase F4: Type-check failed." >&2
  echo "" >&2
  exit 1
fi

# ── Phase F5: DETERMINISTIC — grep for stubs in modified files ──
if ! run_stub_check; then
  echo "Phase F5: Stub check failed." >&2
  echo "" >&2
  exit 1
fi

# ── Phase F6: EVIDENCE SPOT-CHECK — verify file hashes ──
if [[ -f "$EVIDENCE_FILE" ]]; then
  if [[ ! -f "$SCRIPT_DIR/verify-evidence.sh" ]]; then
    echo "BLOCKED: Evidence verification script not found (Phase F6)." >&2
    echo "Expected: $SCRIPT_DIR/verify-evidence.sh" >&2
    echo "" >&2
    exit 1
  fi
  export EVIDENCE_FILE SAMPLE_SIZE=3
  if ! bash "$SCRIPT_DIR/verify-evidence.sh" 3 > /dev/null 2>&1; then
    echo "BLOCKED: Evidence spot-check failed (Phase F6)." >&2
    echo "File hashes in evidence don't match actual files." >&2
    bash "$SCRIPT_DIR/verify-evidence.sh" 3 2>&1 | tail -5 >&2
    echo "" >&2
    exit 1
  fi
fi

# ── Phase F7: INDEPENDENT REVIEW must exist and have no SHELL/MISSING ──
if [[ ! -f "$REVIEW_FILE" ]]; then
  echo "BLOCKED: No independent review file (Phase F7)." >&2
  echo "Gate 3 independent verification did not complete." >&2
  echo "Expected: $REVIEW_FILE" >&2
  echo "" >&2
  exit 1
fi

REVIEW_ISSUES=$(jq -r '
  .requirements[]? |
  select(.rating == "SHELL" or .rating == "MISSING") |
  "\(.req_id // "?"): \(.rating) - \(.description // "no description")"
' "$REVIEW_FILE" 2>/dev/null || true)

if [[ -n "$REVIEW_ISSUES" ]]; then
  echo "BLOCKED: Independent verifier found unresolved issues (Phase F7):" >&2
  echo "$REVIEW_ISSUES" | head -10 >&2
  echo "" >&2
  exit 1
fi

# ── Phase F8: Runtime check (if exists) must have no FAILs ──
if [[ -f "$RUNTIME_FILE" ]]; then
  RUNTIME_FAILS=$(jq -r '
    .checks[]? |
    select(.status == "FAIL") |
    "\(.component // "unknown"): \(.reason // "no reason")"
  ' "$RUNTIME_FILE" 2>/dev/null || true)

  if [[ -n "$RUNTIME_FAILS" ]]; then
    echo "BLOCKED: Runtime verification found failures (Phase F8):" >&2
    echo "$RUNTIME_FAILS" | head -10 >&2
    echo "" >&2
    exit 1
  fi
fi

# ── Phase F9: Validate verdict gate numbers ──
GATE_ERRORS=$(jq -r '
  .gates as $g |
  [
    (if ($g.gate_0.hard_failures // 0) > 0 then "Gate 0: \($g.gate_0.hard_failures) hard failures" else empty end),
    (if ($g.gate_1.missing // 0) > 0 then "Gate 1: \($g.gate_1.missing) missing items" else empty end),
    (if ($g.gate_1.stubs // 0) > 0 then "Gate 1: \($g.gate_1.stubs) stub items" else empty end),
    (if ($g.gate_2.failures // 0) > 0 then "Gate 2: \($g.gate_2.failures) failures" else empty end),
    (if ($g.gate_3.verifier_completed // false) != true then "Gate 3: independent verifier not completed" else empty end),
    (if (($g.gate_3.summary.shell // 0) > 0) or (($g.gate_3.summary.missing // 0) > 0) then "Gate 3: \($g.gate_3.summary.shell // 0) shell + \($g.gate_3.summary.missing // 0) missing" else empty end),
    (if ($g.gate_3.requirements_missing // 0) > 0 then "Gate 3: \($g.gate_3.requirements_missing) unrated requirements" else empty end),
    (if ($g.gate_5.status // "MISSING") != "APPROVED" then "Gate 5: status is \($g.gate_5.status // "MISSING"), not APPROVED" else empty end)
  ] | if length == 0 then "OK" else join("|") end
' "$VERDICT_FILE" 2>/dev/null || echo "OK")

if [[ "$GATE_ERRORS" != "OK" ]]; then
  echo "BLOCKED: Verdict gate validation failed (Phase F9):" >&2
  IFS='|' read -ra ISSUES <<< "$GATE_ERRORS"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue" >&2
  done
  echo "Re-run /sharingan to produce a valid verdict." >&2
  echo "" >&2
  exit 1
fi

# ── All phases passed ──
TIMESTAMP=$(jq -r '.timestamp // ""' "$VERDICT_FILE" 2>/dev/null)
echo "Sharingan: CLEAR — all phases validated independently (${TIMESTAMP})"
exit 0
