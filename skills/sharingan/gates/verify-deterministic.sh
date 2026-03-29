#!/usr/bin/env bash
# Sharingan Gate 0: Deterministic Build Verification
# Language-agnostic — auto-detects project type and runs appropriate checks.
#
# Supported: TypeScript/JS, Java/Kotlin (Gradle/Maven), Python, Rust, Go, Smithy
#
# Usage: verify-deterministic.sh [SHARINGAN_BASE_COMMIT]
# Output: deterministic-results.json in EVIDENCE_DIR
#
# Checks (all deterministic, no LLM judgment):
#   1. Build/type-check (language-appropriate)
#   2. Lint (language-appropriate)
#   3. Stub/TODO/FIXME detection in modified files (all languages)
#   4. Unsafe type usage detection (language-appropriate)
#   5. Component return verification (JSX/TSX only, skipped otherwise)
#   6. Empty function body detection (all languages)
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed (results in JSON)

set -euo pipefail

SHARINGAN_BASE="${1:-HEAD~1}"
CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
PROJECT_HASH=$(echo -n "$PWD" | shasum -a 256 | cut -c1-16)
EVIDENCE_DIR="${CACHE_DIR}/evidence-${PROJECT_HASH}"
mkdir -p "$EVIDENCE_DIR"

FAILURES=0
TYPE_EXIT=0
LINT_EXIT=0
STUBS_FOUND=0
ANY_FOUND=0
JSX_WARNINGS=0
EMPTY_FOUND=0

# ── Load shared library ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib-project-types.sh"

# ── Project type detection ──
PROJECT_TYPES=$(sharingan_detect_languages)
echo "Detected project types: ${PROJECT_TYPES:-none}"

# ══════════════════════════════════════════════════════════════
# Check 1: Build / Type-check (language-appropriate)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [1/6]: Running type-check/build..."

typecheck_ran=false

for lang in $PROJECT_TYPES; do
  tc_exit=0
  sharingan_run_typecheck "$lang" "$EVIDENCE_DIR/typecheck.log" || tc_exit=$?

  if [[ "$SHARINGAN_TC_SKIPPED" == "true" ]]; then
    echo "  SKIP: No type-check tool available for $lang"
    continue
  fi

  typecheck_ran=true
  if [[ $tc_exit -ne 0 ]]; then
    echo "  FAIL: $SHARINGAN_TC_DESC exited with $tc_exit"
    TYPE_EXIT=$tc_exit
    FAILURES=$((FAILURES + 1))
  else
    echo "  PASS ($SHARINGAN_TC_DESC)"
  fi
done

if [[ "$typecheck_ran" == "false" ]]; then
  echo "  SKIP: No recognized project type for type-check (${PROJECT_TYPES:-none})"
fi

# ══════════════════════════════════════════════════════════════
# Check 2: Lint (language-appropriate)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [2/6]: Running lint..."

lint_ran=false

for lang in $PROJECT_TYPES; do
  lint_exit=0
  sharingan_run_lint "$lang" "$EVIDENCE_DIR/lint.log" || lint_exit=$?

  if [[ "$SHARINGAN_LINT_SKIPPED" == "true" ]]; then
    continue
  fi

  lint_ran=true
  if [[ $lint_exit -ne 0 ]]; then
    if [[ "$SHARINGAN_LINT_NON_BLOCKING" == "true" ]]; then
      echo "  WARN: $SHARINGAN_LINT_DESC found issues (non-blocking)"
    else
      echo "  FAIL: $SHARINGAN_LINT_DESC exited with $lint_exit"
      LINT_EXIT=$lint_exit
      FAILURES=$((FAILURES + 1))
    fi
  else
    echo "  PASS ($SHARINGAN_LINT_DESC)"
  fi
done

if [[ "$lint_ran" == "false" ]]; then
  echo "  SKIP: No linter available for detected project types"
fi

# ══════════════════════════════════════════════════════════════
# Check 3: Stub/TODO detection (all languages)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [3/6]: Scanning for stubs/TODOs..."
MODIFIED=$(sharingan_get_all_modified_source "$SHARINGAN_BASE" || true)
STUBS_FOUND=0
STUB_PATTERN=$(sharingan_get_stub_pattern)
> "$EVIDENCE_DIR/stubs.log"
if [[ -n "$MODIFIED" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    grep -nHE "$STUB_PATTERN" "$f" 2>/dev/null >> "$EVIDENCE_DIR/stubs.log" || true
  done <<< "$MODIFIED"
  STUBS_FOUND=$(wc -l < "$EVIDENCE_DIR/stubs.log" | tr -d ' ')
fi
if [[ $STUBS_FOUND -gt 0 ]]; then
  echo "  FAIL: $STUBS_FOUND stub/TODO markers found"
  head -5 "$EVIDENCE_DIR/stubs.log" | while IFS= read -r line; do echo "    $line"; done
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS"
fi

# ══════════════════════════════════════════════════════════════
# Check 4: Unsafe type usage (language-appropriate)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [4/6]: Scanning for unsafe type usage..."
ANY_FOUND=0
> "$EVIDENCE_DIR/any-types.log"

for lang in $PROJECT_TYPES; do
  PATTERNS=$(sharingan_get_unsafe_patterns "$lang")
  [[ -z "$PATTERNS" ]] && continue

  EXTS=$(sharingan_get_extensions "$lang")
  LANG_FILES=""
  for ext in $EXTS; do
    LANG_FILES="$LANG_FILES$(sharingan_get_modified_files "$ext" "$SHARINGAN_BASE")"$'\n'
  done
  LANG_FILES=$(echo "$LANG_FILES" | sort -u | grep -v '^$' || true)
  [[ -z "$LANG_FILES" ]] && continue

  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      grep -nHE "$pattern" "$f" 2>/dev/null >> "$EVIDENCE_DIR/any-types.log" || true
    done <<< "$LANG_FILES"
  done <<< "$PATTERNS"
done

ANY_FOUND=$(wc -l < "$EVIDENCE_DIR/any-types.log" | tr -d ' ')
if [[ $ANY_FOUND -gt 0 ]]; then
  echo "  FAIL: $ANY_FOUND unsafe type usages found"
  head -5 "$EVIDENCE_DIR/any-types.log" | while IFS= read -r line; do echo "    $line"; done
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS"
fi

# ══════════════════════════════════════════════════════════════
# Check 5: Component return verification (JSX/TSX only)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [5/6]: Verifying component returns..."
JSX_WARNINGS=0
> "$EVIDENCE_DIR/jsx-check.log"
if echo "$PROJECT_TYPES" | grep -q "typescript"; then
  TSX_FILES=$(sharingan_get_modified_files "tsx" "$SHARINGAN_BASE")
  if [[ -n "$TSX_FILES" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      if grep -qE 'export\s+(default\s+)?function|export\s+(default\s+)?const' "$f" 2>/dev/null; then
        if ! grep -qE 'return\s*\(?\s*<|return\s+<|return\s*\(\s*$' "$f" 2>/dev/null; then
          echo "$f: no JSX return statement found" >> "$EVIDENCE_DIR/jsx-check.log"
          JSX_WARNINGS=$((JSX_WARNINGS + 1))
        fi
      fi
    done <<< "$TSX_FILES"
  fi
fi
if [[ $JSX_WARNINGS -gt 0 ]]; then
  echo "  FAIL: $JSX_WARNINGS .tsx component files without JSX returns"
  cat "$EVIDENCE_DIR/jsx-check.log" | while IFS= read -r line; do echo "    $line"; done
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS"
fi

# ══════════════════════════════════════════════════════════════
# Check 6: Empty function body detection (all languages)
# ══════════════════════════════════════════════════════════════
echo "Gate 0 [6/6]: Scanning for empty/minimal function bodies..."
EMPTY_FOUND=0
> "$EVIDENCE_DIR/empty-functions.log"
if [[ -n "$MODIFIED" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    python3 -c "
import re, sys
with open(sys.argv[1]) as fh:
    content = fh.read()
    lines = content.split('\n')
    ext = sys.argv[1].rsplit('.', 1)[-1] if '.' in sys.argv[1] else ''
    # Language-aware function patterns
    patterns = []
    if ext in ('ts', 'tsx', 'js', 'jsx'):
        patterns.append(r'\s*(export\s+)?(default\s+)?function\s+\w+|export\s+(default\s+)?const\s+\w+\s*=\s*\(')
    elif ext in ('java', 'kt', 'kts', 'scala', 'cs'):
        patterns.append(r'\s*(public|private|protected|internal|override)?\s*(static\s+)?(fun|void|int|String|boolean|long|double|float|def|var|val)\s+\w+\s*\(')
    elif ext == 'py':
        patterns.append(r'\s*def\s+\w+\s*\(')
    elif ext == 'rs':
        patterns.append(r'\s*(pub\s+)?fn\s+\w+')
    elif ext == 'go':
        patterns.append(r'\s*func\s+')
    else:
        sys.exit(0)
    for pat in patterns:
        for i, line in enumerate(lines):
            if re.match(pat, line):
                brace_count = 0
                body_lines = 0
                started = False
                open_char = '{' if ext != 'py' else ':'
                for j in range(i, min(i+50, len(lines))):
                    if ext == 'py':
                        if j > i and lines[j].strip() and not lines[j].strip().startswith('#'):
                            body_lines += 1
                        if j > i + 1 and lines[j].strip() and not lines[j].startswith(' ') and not lines[j].startswith('\t'):
                            break
                        if ':' in lines[i]:
                            started = True
                    else:
                        brace_count += lines[j].count('{') - lines[j].count('}')
                        if '{' in lines[j]:
                            started = True
                        if started:
                            stripped = lines[j].strip()
                            if stripped and not stripped.startswith('//') and not stripped.startswith('#') and stripped not in ('{', '}', '};', '},'):
                                body_lines += 1
                        if started and brace_count <= 0:
                            break
                if started and body_lines <= 3:
                    print(f'{sys.argv[1]}:{i+1}: function has only {body_lines} substantive lines')
" "$f" 2>/dev/null >> "$EVIDENCE_DIR/empty-functions.log" || true
  done <<< "$MODIFIED"
  EMPTY_FOUND=$(wc -l < "$EVIDENCE_DIR/empty-functions.log" | tr -d ' ')
fi
if [[ $EMPTY_FOUND -gt 0 ]]; then
  echo "  WARN: $EMPTY_FOUND potentially empty/minimal functions (review manually)"
  head -5 "$EVIDENCE_DIR/empty-functions.log" | while IFS= read -r line; do echo "    $line"; done
else
  echo "  PASS"
fi

# ── Write results ──
cat > "$EVIDENCE_DIR/deterministic-results.json" << ENDJSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project": "$PWD",
  "project_types": "$(echo $PROJECT_TYPES | xargs)",
  "sharingan_base": "$SHARINGAN_BASE",
  "checks": {
    "typecheck": { "exit_code": $TYPE_EXIT, "log": "typecheck.log" },
    "lint": { "exit_code": $LINT_EXIT, "log": "lint.log" },
    "stubs": { "count": $STUBS_FOUND, "log": "stubs.log" },
    "unsafe_types": { "count": $ANY_FOUND, "log": "any-types.log" },
    "component_returns": { "warnings": $JSX_WARNINGS, "log": "jsx-check.log" },
    "empty_functions": { "count": $EMPTY_FOUND, "log": "empty-functions.log" }
  },
  "hard_failures": $FAILURES,
  "verdict": "$([ $FAILURES -eq 0 ] && echo 'PASS' || echo 'FAIL')"
}
ENDJSON

echo ""
echo "Gate 0 Results: $FAILURES hard failures"
echo "Results written to: $EVIDENCE_DIR/deterministic-results.json"

[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
