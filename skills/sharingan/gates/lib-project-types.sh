#!/usr/bin/env bash
# SPSM Sharingan — Shared Config Library
# Single source of truth for all language/framework detection.
#
# Usage: source this file from any sharingan script.
#   source "$(dirname "${BASH_SOURCE[0]}")/lib-project-types.sh"
#
# Reads project-types config via jq. Config is loaded once into SHARINGAN_CONFIG.
#
# Config lookup order (first found wins):
#   1. $SCRIPT_DIR/../config/project-types.json  (bundled with plugin)
#   2. ~/.config/spsm/policy/project-types.json   (user override)
#   3. Fallback to minimal hardcoded behavior (degraded but functional)

# ── Guard: only load once ──
[[ -n "${SHARINGAN_LIB_LOADED:-}" ]] && return 0
SHARINGAN_LIB_LOADED=true

# ── Config paths (resolved dynamically, no hardcoded defaults) ──
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARINGAN_CONFIG_FILE="${_LIB_DIR}/../config/project-types.json"
if [[ ! -f "$SHARINGAN_CONFIG_FILE" ]]; then
    SHARINGAN_CONFIG_FILE="${SPSM_CONFIG_DIR:-$HOME/.config/spsm}/policy/project-types.json"
fi
SHARINGAN_CONFIG_LOADED=false

# ══════════════════════════════════════════════════════════════
# Section 1: Config Loading
# ══════════════════════════════════════════════════════════════

sharingan_load_config() {
  if [[ -f "$SHARINGAN_CONFIG_FILE" ]] && command -v jq >/dev/null 2>&1; then
    if jq empty "$SHARINGAN_CONFIG_FILE" 2>/dev/null; then
      SHARINGAN_CONFIG_LOADED=true
    else
      echo "WARN: project-types.json is invalid JSON, using fallback" >&2
      SHARINGAN_CONFIG_LOADED=false
    fi
  else
    SHARINGAN_CONFIG_LOADED=false
  fi
}

# Read config values directly from file (never pipe through echo — it corrupts backslash escapes).
_cfg_jq() {
  jq "$@" "$SHARINGAN_CONFIG_FILE"
}

sharingan_load_config

# ══════════════════════════════════════════════════════════════
# Section 1b: Timeout Support
# ══════════════════════════════════════════════════════════════

# Timeout defaults (seconds). Override via environment.
SHARINGAN_TIMEOUT_TC="${SHARINGAN_TIMEOUT_TC:-120}"
SHARINGAN_TIMEOUT_LINT="${SHARINGAN_TIMEOUT_LINT:-120}"
SHARINGAN_TIMEOUT_BUILD="${SHARINGAN_TIMEOUT_BUILD:-180}"

# Detect timeout command (Linux: timeout, macOS: gtimeout)
_SHARINGAN_TMO=""
command -v timeout >/dev/null 2>&1 && _SHARINGAN_TMO="timeout"
[[ -z "$_SHARINGAN_TMO" ]] && command -v gtimeout >/dev/null 2>&1 && _SHARINGAN_TMO="gtimeout"

# Run a command with timeout. Caller handles redirection.
# Usage: _sharingan_timed <seconds> <command...> [> logfile 2>&1]
# Returns: command exit code, or 1 on timeout (prints TIMEOUT to stderr)
_sharingan_timed() {
  local secs="$1"
  shift
  local rc=0
  if [[ -n "$_SHARINGAN_TMO" ]]; then
    "$_SHARINGAN_TMO" "$secs" "$@" || rc=$?
  else
    "$@" || rc=$?
  fi
  if [[ $rc -eq 124 ]]; then
    echo "TIMEOUT: $* exceeded ${secs}s" >&2
    return 1
  fi
  return $rc
}

# ══════════════════════════════════════════════════════════════
# Section 1c: Project Hash
# ══════════════════════════════════════════════════════════════

# Standardized project hash (SHA-256, 16 chars). SSOT for all sharingan scripts.
# Uses shasum (POSIX, available on macOS + Linux).
sharingan_project_hash() {
  echo -n "${1:-$PWD}" | shasum -a 256 | cut -c1-16
}

# ══════════════════════════════════════════════════════════════
# Section 2: Language Detection
# ══════════════════════════════════════════════════════════════

# Detect project types from marker files in current directory.
# Returns space-separated list (e.g., "typescript gradle").
sharingan_detect_languages() {
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local types=""
    local fallbacks=""
    local langs
    langs=$(_cfg_jq -r '.languages | keys[]')

    while IFS= read -r lang; do
      [[ -z "$lang" ]] && continue
      local is_fallback
      is_fallback=$(_cfg_jq -r ".languages[\"$lang\"].fallback_only // false")

      local found=false

      # Check marker_files
      local marker_files
      marker_files=$(_cfg_jq -r ".languages[\"$lang\"].marker_files // [] | .[]" 2>/dev/null)
      while IFS= read -r mf; do
        [[ -z "$mf" ]] && continue
        if [[ -f "$mf" || -x "$mf" ]]; then
          found=true
          break
        fi
      done <<< "$marker_files"

      # Check marker_globs if not found yet
      if [[ "$found" == "false" ]]; then
        local marker_globs
        marker_globs=$(_cfg_jq -r ".languages[\"$lang\"].marker_globs // [] | .[]" 2>/dev/null)
        while IFS= read -r mg; do
          [[ -z "$mg" ]] && continue
          if ls $mg 2>/dev/null | head -1 | grep -q .; then
            found=true
            break
          fi
        done <<< "$marker_globs"
      fi

      if [[ "$found" == "true" ]]; then
        if [[ "$is_fallback" == "true" ]]; then
          fallbacks="$fallbacks $lang"
        else
          types="$types $lang"
        fi
      fi
    done <<< "$langs"

    # Fallback-only languages: detect only if no primary language found
    if [[ -z "$(echo "$types" | xargs)" ]]; then
      # For shell: check if .sh files exist (special detection)
      if echo "$fallbacks" | grep -q "shell"; then
        local sh_count
        sh_count=$(find . -maxdepth 2 -name "*.sh" 2>/dev/null | head -5 | wc -l | tr -d ' ')
        if [[ "$sh_count" -gt 0 ]]; then
          types="$types shell"
        fi
      fi
      # For docker and others, marker_files already handled above
      for fb in $fallbacks; do
        [[ "$fb" == "shell" ]] && continue
        types="$types $fb"
      done
    fi

    echo "$types" | xargs
    return
  fi

  # ── Fallback: hardcoded detection ──
  local types=""
  [[ -f "tsconfig.json" || -f "package.json" ]] && types="$types typescript"
  [[ -f "build.gradle" || -f "build.gradle.kts" || -f "gradlew" ]] && types="$types gradle"
  [[ -f "pom.xml" ]] && types="$types maven"
  [[ -f "pyproject.toml" || -f "requirements.txt" ]] && types="$types python"
  [[ -f "Cargo.toml" ]] && types="$types rust"
  [[ -f "go.mod" ]] && types="$types go"
  if [[ -z "$(echo "$types" | xargs)" ]]; then
    [[ -f "docker-compose.yml" || -f "Dockerfile" ]] && types="$types docker"
  fi
  echo "$types" | xargs
}

# Detect languages from a list of file extensions (for verify-independent.sh).
# Input: newline-separated list of modified files.
# Output: space-separated list of detected language labels.
sharingan_detect_languages_from_files() {
  local files="$1"

  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local langs=""
    local lang_map
    lang_map=$(_cfg_jq -r '.global.language_detection_by_extension | to_entries[] | "\(.key):\(.value | join(","))"')

    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      local label="${entry%%:*}"
      local exts="${entry#*:}"
      IFS=',' read -ra ext_arr <<< "$exts"
      for ext in "${ext_arr[@]}"; do
        if echo "$files" | grep -qE "\\.${ext}$"; then
          if ! echo "$langs" | grep -q "$label"; then
            langs="$langs $label"
          fi
          break
        fi
      done
    done <<< "$lang_map"

    echo "$langs" | xargs
    return
  fi

  # ── Fallback ──
  local langs=""
  echo "$files" | grep -qE '\.(tsx?|jsx?)$' && langs="$langs typescript-javascript"
  echo "$files" | grep -qE '\.(java|kt|kts)$' && langs="$langs java-kotlin"
  echo "$files" | grep -qE '\.py$' && langs="$langs python"
  echo "$files" | grep -qE '\.go$' && langs="$langs go"
  echo "$files" | grep -qE '\.rs$' && langs="$langs rust"
  echo "$files" | grep -qE '\.smithy$' && langs="$langs smithy"
  echo "$files" | grep -qE '\.(sh|bash)$' && langs="$langs shell"
  echo "$langs" | xargs
}

# ══════════════════════════════════════════════════════════════
# Section 3: Package Manager / npm Scripts
# ══════════════════════════════════════════════════════════════

# Detect JS/TS package manager runner (bun, pnpm, yarn, npx).
sharingan_detect_runner() {
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local pm_entries
    pm_entries=$(_cfg_jq -r '.languages.typescript.package_managers // {} | to_entries[] | "\(.key):\(.value)"')
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      local lockfile="${entry%%:*}"
      local runner="${entry#*:}"
      if [[ -f "$lockfile" ]]; then
        echo "$runner"
        return
      fi
    done <<< "$pm_entries"
    echo "$(_cfg_jq -r '.languages.typescript.default_runner // "npx"')"
    return
  fi

  # ── Fallback ──
  [[ -f "bun.lockb" || -f "bun.lock" ]] && echo "bun" && return
  [[ -f "pnpm-lock.yaml" ]] && echo "pnpm" && return
  [[ -f "yarn.lock" ]] && echo "yarn" && return
  echo "npx"
}

# Detect npm script by category (typecheck, lint).
# Args: $1 = language (must be "typescript"), $2 = category ("typecheck" or "lint")
# Returns: script name if found, empty if not.
sharingan_detect_npm_script() {
  local lang="$1"
  local category="$2"
  [[ ! -f "package.json" ]] && return

  local candidates=""
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    candidates=$(_cfg_jq -r ".languages[\"$lang\"].$category.npm_scripts // [] | .[]" 2>/dev/null)
  else
    if [[ "$category" == "typecheck" ]]; then
      candidates="type-check typecheck tsc check:types check-types"
    elif [[ "$category" == "lint" ]]; then
      candidates="lint eslint check:lint lint:check"
    fi
  fi

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if python3 -c "import json,sys; scripts=json.load(open('package.json')).get('scripts',{}); sys.exit(0 if '$candidate' in scripts else 1)" 2>/dev/null; then
      echo "$candidate"
      return
    fi
  done <<< "$candidates"
}

# ══════════════════════════════════════════════════════════════
# Section 4: Typecheck Commands
# ══════════════════════════════════════════════════════════════

# Run typecheck for a specific language.
# Args: $1 = language name, $2 = log file (optional, defaults to /dev/null)
# Returns: 0 = pass/skip, non-zero = fail
# Sets: SHARINGAN_TC_DESC (what ran), SHARINGAN_TC_SKIPPED (true if no tool)
sharingan_run_typecheck() {
  local lang="$1"
  local log_file="${2:-/dev/null}"
  SHARINGAN_TC_DESC=""
  SHARINGAN_TC_SKIPPED=false

  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local has_npm_scripts
    has_npm_scripts=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.npm_scripts // [] | length")

    # Strategy 1: npm script detection (JS/TS style)
    if [[ "$has_npm_scripts" -gt 0 ]]; then
      local runner
      runner=$(sharingan_detect_runner)
      local script
      script=$(sharingan_detect_npm_script "$lang" "typecheck")

      if [[ -n "$script" ]]; then
        SHARINGAN_TC_DESC="$lang: $runner run $script"
        _sharingan_timed "$SHARINGAN_TIMEOUT_TC" $runner run "$script" > "$log_file" 2>&1
        return $?
      fi

      # Run preamble if configured
      local preamble_cmd
      preamble_cmd=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.preamble.cmd // empty")
      if [[ -n "$preamble_cmd" ]]; then
        local preamble_files
        preamble_files=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.preamble.condition_files // [] | .[]")
        while IFS= read -r cf; do
          [[ -z "$cf" ]] && continue
          if [[ -f "$cf" ]]; then
            _sharingan_timed 60 bash -c "$runner $preamble_cmd" >> "$log_file" 2>&1 || true
            break
          fi
        done <<< "$preamble_files"
      fi

      # Run fallback command
      local fallback_cmd
      fallback_cmd=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.fallback.cmd // empty")
      local fallback_cond
      fallback_cond=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.fallback.condition_file // empty")

      if [[ -n "$fallback_cmd" ]]; then
        if [[ -z "$fallback_cond" || -f "$fallback_cond" ]]; then
          SHARINGAN_TC_DESC="$lang: $runner $fallback_cmd"
          _sharingan_timed "$SHARINGAN_TIMEOUT_TC" bash -c "$runner $fallback_cmd" > "$log_file" 2>&1
          return $?
        fi
      fi

      SHARINGAN_TC_SKIPPED=true
      return 0
    fi

    # Strategy 2: command chain (Gradle, Maven, Python, Rust, Go)
    local cmd_count
    cmd_count=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.commands // [] | length")
    if [[ "$cmd_count" -gt 0 ]]; then
      local i=0
      while [[ $i -lt $cmd_count ]]; do
        local cmd
        cmd=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.commands[$i].cmd")
        local executable
        executable=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.commands[$i].executable // empty")
        local requires
        requires=$(_cfg_jq -r ".languages[\"$lang\"].typecheck.commands[$i].requires // empty")

        local can_run=true
        if [[ -n "$executable" && ! -x "$executable" ]]; then
          can_run=false
        fi
        if [[ -n "$requires" ]] && ! command -v "$requires" >/dev/null 2>&1; then
          can_run=false
        fi

        if [[ "$can_run" == "true" ]]; then
          SHARINGAN_TC_DESC="$lang: $cmd"
          _sharingan_timed "$SHARINGAN_TIMEOUT_TC" bash -c "$cmd" > "$log_file" 2>&1
          return $?
        fi

        i=$((i + 1))
      done
    fi

    SHARINGAN_TC_SKIPPED=true
    return 0
  fi

  # ── Fallback: hardcoded commands ──
  case "$lang" in
    typescript)
      if [[ -f "tsconfig.json" ]]; then
        SHARINGAN_TC_DESC="typescript: npx tsc --noEmit"
        _sharingan_timed "$SHARINGAN_TIMEOUT_TC" npx tsc --noEmit > "$log_file" 2>&1
        return $?
      fi
      ;;
    gradle)
      if [[ -x "./gradlew" ]]; then
        SHARINGAN_TC_DESC="gradle: ./gradlew build"
        _sharingan_timed "$SHARINGAN_TIMEOUT_BUILD" ./gradlew build --no-daemon > "$log_file" 2>&1
        return $?
      fi
      ;;
    python)
      if command -v mypy >/dev/null 2>&1; then
        SHARINGAN_TC_DESC="python: mypy"
        _sharingan_timed "$SHARINGAN_TIMEOUT_TC" mypy . > "$log_file" 2>&1
        return $?
      fi
      ;;
    rust)
      SHARINGAN_TC_DESC="rust: cargo check"
      _sharingan_timed "$SHARINGAN_TIMEOUT_TC" cargo check > "$log_file" 2>&1
      return $?
      ;;
    go)
      SHARINGAN_TC_DESC="go: go vet"
      _sharingan_timed "$SHARINGAN_TIMEOUT_TC" go vet ./... > "$log_file" 2>&1
      return $?
      ;;
  esac

  SHARINGAN_TC_SKIPPED=true
  return 0
}

# ══════════════════════════════════════════════════════════════
# Section 5: Lint Commands
# ══════════════════════════════════════════════════════════════

# Run lint for a specific language.
# Args: $1 = language name, $2 = log file (optional)
# Returns: 0 = pass/skip, non-zero = fail
# Sets: SHARINGAN_LINT_DESC, SHARINGAN_LINT_SKIPPED, SHARINGAN_LINT_NON_BLOCKING
sharingan_run_lint() {
  local lang="$1"
  local log_file="${2:-/dev/null}"
  SHARINGAN_LINT_DESC=""
  SHARINGAN_LINT_SKIPPED=false
  SHARINGAN_LINT_NON_BLOCKING=false

  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local has_npm_scripts
    has_npm_scripts=$(_cfg_jq -r ".languages[\"$lang\"].lint.npm_scripts // [] | length")

    # Strategy 1: npm script
    if [[ "$has_npm_scripts" -gt 0 ]]; then
      local runner
      runner=$(sharingan_detect_runner)
      local script
      script=$(sharingan_detect_npm_script "$lang" "lint")

      if [[ -n "$script" ]]; then
        SHARINGAN_LINT_DESC="$lang: $runner run $script"
        _sharingan_timed "$SHARINGAN_TIMEOUT_LINT" $runner run "$script" > "$log_file" 2>&1
        return $?
      fi

      # Fallback command
      local fallback_cmd
      fallback_cmd=$(_cfg_jq -r ".languages[\"$lang\"].lint.fallback.cmd // empty")
      if [[ -n "$fallback_cmd" ]]; then
        SHARINGAN_LINT_DESC="$lang: $runner $fallback_cmd"
        _sharingan_timed "$SHARINGAN_TIMEOUT_LINT" bash -c "$runner $fallback_cmd" > "$log_file" 2>&1
        return $?
      fi

      SHARINGAN_LINT_SKIPPED=true
      return 0
    fi

    # Strategy 2: command chain
    local cmd_count
    cmd_count=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands // [] | length")
    if [[ "$cmd_count" -gt 0 ]]; then
      local i=0
      while [[ $i -lt $cmd_count ]]; do
        local cmd
        cmd=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands[$i].cmd")
        local executable
        executable=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands[$i].executable // empty")
        local requires
        requires=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands[$i].requires // empty")
        local task
        task=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands[$i].task // empty")
        local non_blocking
        non_blocking=$(_cfg_jq -r ".languages[\"$lang\"].lint.commands[$i].non_blocking // false")

        local can_run=true
        if [[ -n "$executable" && ! -x "$executable" ]]; then
          can_run=false
        fi
        if [[ -n "$requires" ]] && ! command -v "$requires" >/dev/null 2>&1; then
          can_run=false
        fi
        # Gradle task check
        if [[ "$can_run" == "true" && -n "$task" && -n "$executable" ]]; then
          if ! $executable tasks --no-daemon 2>/dev/null | grep -q "$task"; then
            can_run=false
          fi
        fi

        if [[ "$can_run" == "true" ]]; then
          SHARINGAN_LINT_DESC="$lang: $cmd"
          [[ "$non_blocking" == "true" ]] && SHARINGAN_LINT_NON_BLOCKING=true
          _sharingan_timed "$SHARINGAN_TIMEOUT_LINT" bash -c "$cmd" > "$log_file" 2>&1
          return $?
        fi

        i=$((i + 1))
      done
    fi

    SHARINGAN_LINT_SKIPPED=true
    return 0
  fi

  # ── Fallback ──
  case "$lang" in
    typescript)
      if command -v eslint >/dev/null 2>&1 || [[ -f "node_modules/.bin/eslint" ]]; then
        SHARINGAN_LINT_DESC="typescript: eslint"
        _sharingan_timed "$SHARINGAN_TIMEOUT_LINT" npx eslint . > "$log_file" 2>&1
        return $?
      fi
      ;;
    rust)
      SHARINGAN_LINT_DESC="rust: cargo clippy"
      _sharingan_timed "$SHARINGAN_TIMEOUT_LINT" cargo clippy -- -D warnings > "$log_file" 2>&1
      return $?
      ;;
  esac

  SHARINGAN_LINT_SKIPPED=true
  return 0
}

# ══════════════════════════════════════════════════════════════
# Section 6: File Extensions
# ══════════════════════════════════════════════════════════════

# Get file extensions for a language.
# Args: $1 = language name
# Returns: space-separated extensions.
sharingan_get_extensions() {
  local lang="$1"
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    _cfg_jq -r ".languages[\"$lang\"].extensions // [] | .[]" | tr '\n' ' '
    return
  fi
  case "$lang" in
    typescript) echo "ts tsx js jsx mjs" ;;
    gradle) echo "java kt kts" ;;
    python) echo "py" ;;
    rust) echo "rs" ;;
    go) echo "go" ;;
    *) echo "" ;;
  esac
}

# Get all source file extensions for modified file scanning.
sharingan_get_all_extensions() {
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    _cfg_jq -r '.global.all_source_extensions // [] | .[]' | tr '\n' ' '
    return
  fi
  echo "ts tsx js jsx java kt kts py rs go smithy sh bash sql rb c cpp h hpp cs scala ex exs"
}

# ══════════════════════════════════════════════════════════════
# Section 7: Pattern Queries
# ══════════════════════════════════════════════════════════════

# Get stub/TODO grep pattern (extended regex).
sharingan_get_stub_pattern() {
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    _cfg_jq -r '.global.stub_pattern // empty'
    return
  fi
  echo '(//|/\*|\*|#|--)\s*.*(TODO|FIXME|HACK)|[Nn]ot.[Ii]mplemented|[Cc]oming.[Ss]oon|raise NotImplementedError|todo!|unimplemented!|panic\("not implemented'
}

# Get unsafe type patterns for a language (array, one per line).
sharingan_get_unsafe_patterns() {
  local lang="$1"
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    _cfg_jq -r ".languages[\"$lang\"].unsafe_patterns // [] | .[]"
    return
  fi
  case "$lang" in
    typescript) printf '%s\n' ':[[:space:]]*any([^[:alnum:]_]|$)' 'as[[:space:]]+any([^[:alnum:]_]|$)' ;;
    python) echo '#\s*type:\s*ignore' ;;
    rust) echo '\bunsafe\b' ;;
    go) echo 'interface\{\}' ;;
  esac
}

# Get build commands regex for pipeline stage gating.
sharingan_get_build_regex() {
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    _cfg_jq -r '.global.build_commands_regex // empty'
    return
  fi
  echo 'npm run (build|dev|start)|npx tsc|pnpm |yarn (build|dev)|bun run (build|dev)|gradlew |gradle |mvn |cargo (build|run|test)|go (build|run|test)|make |bazel |python setup\.py|pip install|poetry (install|build)'
}

# ══════════════════════════════════════════════════════════════
# Section 8: Framework Detection
# ══════════════════════════════════════════════════════════════

# Detect frameworks from dependency files.
# Returns: space-separated list of framework names.
sharingan_detect_frameworks() {
  local frameworks=""

  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    local fw_names
    fw_names=$(_cfg_jq -r '.frameworks | keys[]')

    while IFS= read -r fw; do
      [[ -z "$fw" ]] && continue

      # Check marker_files
      local marker_files
      marker_files=$(_cfg_jq -r ".frameworks[\"$fw\"].marker_files // [] | .[]" 2>/dev/null)
      local found_marker=false
      while IFS= read -r mf; do
        [[ -z "$mf" ]] && continue
        if [[ -f "$mf" ]]; then
          found_marker=true
          break
        fi
      done <<< "$marker_files"

      if [[ "$found_marker" == "true" ]]; then
        frameworks="$frameworks $fw"
        continue
      fi

      # Check marker_globs
      local marker_globs
      marker_globs=$(_cfg_jq -r ".frameworks[\"$fw\"].marker_globs // [] | .[]" 2>/dev/null)
      local found_glob=false
      while IFS= read -r mg; do
        [[ -z "$mg" ]] && continue
        if find . -maxdepth 3 -name "$mg" -print -quit 2>/dev/null | grep -q .; then
          found_glob=true
          break
        fi
      done <<< "$marker_globs"

      if [[ "$found_glob" == "true" ]]; then
        frameworks="$frameworks $fw"
        continue
      fi

      # Check dependency strings in dependency files
      local dep_files=""
      local single_dep_file
      single_dep_file=$(_cfg_jq -r ".frameworks[\"$fw\"].dependency_file // empty" 2>/dev/null)
      if [[ -n "$single_dep_file" ]]; then
        dep_files="$single_dep_file"
      else
        dep_files=$(_cfg_jq -r ".frameworks[\"$fw\"].dependency_files // [] | .[]" 2>/dev/null)
      fi

      local dep_strings
      dep_strings=$(_cfg_jq -r ".frameworks[\"$fw\"].dependency_strings // [] | .[]" 2>/dev/null)
      [[ -z "$dep_strings" ]] && continue

      local dep_content=""
      while IFS= read -r df; do
        [[ -z "$df" || ! -f "$df" ]] && continue
        dep_content="$dep_content $(cat "$df" 2>/dev/null)"
      done <<< "$dep_files"

      [[ -z "$dep_content" ]] && continue

      while IFS= read -r ds; do
        [[ -z "$ds" ]] && continue
        if echo "$dep_content" | grep -qi "$ds"; then
          frameworks="$frameworks $fw"
          break
        fi
      done <<< "$dep_strings"
    done <<< "$fw_names"

    # Handle fallback_for: if a language has a framework marked as fallback
    # and no specific framework was detected for that language
    local fallback_fws
    fallback_fws=$(_cfg_jq -r '.frameworks | to_entries[] | select(.value.fallback_for) | "\(.key):\(.value.fallback_for)"' 2>/dev/null)
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      local fb_name="${entry%%:*}"
      local fb_parent="${entry#*:}"
      # Check if parent language is detected but no framework from that parent is in the list
      local parent_detected=false
      local parent_fw_found=false
      local detected_langs
      detected_langs=$(sharingan_detect_languages)
      echo "$detected_langs" | grep -q "$fb_parent" && parent_detected=true

      if [[ "$parent_detected" == "true" ]]; then
        local all_parent_fws
        all_parent_fws=$(_cfg_jq -r ".frameworks | to_entries[] | select(.value.parent_language == \"$fb_parent\" and (.value.fallback_for | not)) | .key" 2>/dev/null)
        while IFS= read -r pfw; do
          [[ -z "$pfw" ]] && continue
          if echo "$frameworks" | grep -q "$pfw"; then
            parent_fw_found=true
            break
          fi
        done <<< "$all_parent_fws"

        if [[ "$parent_fw_found" == "false" ]]; then
          frameworks="$frameworks $fb_name"
        fi
      fi
    done <<< "$fallback_fws"

    echo "$frameworks" | xargs
    return
  fi

  # ── Fallback: minimal detection ──
  [[ -f "next.config.js" || -f "next.config.mjs" || -f "next.config.ts" ]] && frameworks="$frameworks nextjs"
  if [[ -f "package.json" ]]; then
    grep -q '"express"' package.json 2>/dev/null && frameworks="$frameworks express"
  fi
  [[ -f "docker-compose.yml" || -f "docker-compose.yaml" ]] && frameworks="$frameworks docker"
  echo "$frameworks" | xargs
}

# ══════════════════════════════════════════════════════════════
# Section 9: Port Detection
# ══════════════════════════════════════════════════════════════

# Detect dev server port from env files, docker-compose, or framework defaults.
# Args: $1 = space-separated framework list
sharingan_detect_port() {
  local frameworks="$1"

  # Check env files first
  local env_files=""
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    env_files=$(_cfg_jq -r '.global.port_env_files // [] | .[]')
  else
    env_files=".env .env.local .env.development"
  fi

  while IFS= read -r envfile; do
    [[ -z "$envfile" || ! -f "$envfile" ]] && continue
    local env_port
    env_port=$(grep -E '^PORT=' "$envfile" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" | xargs)
    [[ -n "$env_port" ]] && echo "$env_port" && return
  done <<< "$env_files"

  # Check docker-compose port mappings
  for dcfile in docker-compose.yml docker-compose.yaml compose.yml; do
    if [[ -f "$dcfile" ]]; then
      local dc_port
      dc_port=$(grep -E '^\s*-\s*"?\d+:\d+"?' "$dcfile" 2>/dev/null | head -1 | sed 's/.*"\?\([0-9]*\):.*/\1/' | tr -d '"' | xargs)
      [[ -n "$dc_port" ]] && echo "$dc_port" && return
    fi
  done

  # Framework-specific defaults from config
  if [[ "$SHARINGAN_CONFIG_LOADED" == "true" ]]; then
    for fw in $frameworks; do
      local port
      port=$(_cfg_jq -r ".frameworks[\"$fw\"].default_port // empty" 2>/dev/null)
      if [[ -n "$port" ]]; then
        echo "$port"
        return
      fi
    done
  fi

  # Absolute fallback
  echo "3000"
}

# ══════════════════════════════════════════════════════════════
# Section 10: Runtime Pattern Matching
# ══════════════════════════════════════════════════════════════

# Classify a file as page, api, or neither using runtime_patterns config.
# Args: $1 = file path
# Returns: "page:<tag>" or "api:<tag>" or empty
# Note: for api patterns with content_check, caller must have file readable.
sharingan_classify_runtime_file() {
  local filepath="$1"

  if [[ "$SHARINGAN_CONFIG_LOADED" != "true" ]]; then
    echo ""
    return
  fi

  # Check page patterns
  local page_count
  page_count=$(_cfg_jq -r '.runtime_patterns.page_patterns | length')
  local i=0
  while [[ $i -lt $page_count ]]; do
    local regex tag
    regex=$(_cfg_jq -r ".runtime_patterns.page_patterns[$i].regex")
    tag=$(_cfg_jq -r ".runtime_patterns.page_patterns[$i].tag")
    if [[ "$filepath" =~ $regex ]]; then
      echo "page:${tag}:${filepath}"
      return
    fi
    i=$((i + 1))
  done

  # Skip smithy files (no runtime)
  [[ "$filepath" =~ \.smithy$ ]] && return

  # Check api patterns
  local api_count
  api_count=$(_cfg_jq -r '.runtime_patterns.api_patterns | length')
  i=0
  while [[ $i -lt $api_count ]]; do
    local regex tag content_check
    regex=$(_cfg_jq -r ".runtime_patterns.api_patterns[$i].regex")
    tag=$(_cfg_jq -r ".runtime_patterns.api_patterns[$i].tag")
    content_check=$(_cfg_jq -r ".runtime_patterns.api_patterns[$i].content_check // empty")

    if [[ "$filepath" =~ $regex ]]; then
      if [[ -n "$content_check" ]]; then
        # Must also match file content
        if [[ -f "$filepath" ]] && grep -qE "$content_check" "$filepath" 2>/dev/null; then
          echo "api:${tag}:${filepath}"
          return
        fi
      else
        echo "api:${tag}:${filepath}"
        return
      fi
    fi
    i=$((i + 1))
  done
}

# ══════════════════════════════════════════════════════════════
# Section 11: Shell Detection Checklist
# ══════════════════════════════════════════════════════════════

# Build shell detection checklist text for the independent verifier prompt.
# Args: $1 = space-separated list of detected language labels
# Returns: formatted checklist text for embedding in the verifier prompt.
sharingan_build_shell_checklist() {
  local languages="$1"

  if [[ "$SHARINGAN_CONFIG_LOADED" != "true" ]]; then
    echo "Apply language-appropriate shell detection checks."
    return
  fi

  local output=""

  # Map language labels to config language keys
  local config_langs
  config_langs=$(_cfg_jq -r '.languages | keys[]')

  while IFS= read -r lang; do
    [[ -z "$lang" ]] && continue

    local shell_det
    shell_det=$(_cfg_jq -r ".languages[\"$lang\"].shell_detection // {} | keys[]" 2>/dev/null)
    [[ -z "$shell_det" ]] && continue

    while IFS= read -r category; do
      [[ -z "$category" ]] && continue

      local label
      label=$(_cfg_jq -r ".languages[\"$lang\"].shell_detection[\"$category\"].label // \"$lang $category\"")
      local threshold
      threshold=$(_cfg_jq -r ".languages[\"$lang\"].shell_detection[\"$category\"].threshold // 3")
      local checks
      checks=$(_cfg_jq -r ".languages[\"$lang\"].shell_detection[\"$category\"].checks // [] | .[]")

      output="${output}--- ${label} ---"$'\n'
      while IFS= read -r check; do
        [[ -z "$check" ]] && continue
        output="${output}- ${check}"$'\n'
      done <<< "$checks"
      output="${output}Fails ${threshold}+ = SHELL"$'\n'$'\n'
    done <<< "$shell_det"
  done <<< "$config_langs"

  echo "$output"
}

# ══════════════════════════════════════════════════════════════
# Section 12: Modified File Helpers
# ══════════════════════════════════════════════════════════════

# Get modified files by extension since a base commit.
# Args: $1 = extension, $2 = base commit (default HEAD~1)
sharingan_get_modified_files() {
  local ext="$1"
  local base="${2:-HEAD~1}"
  { git diff --name-only "$base" -- "*.${ext}" 2>/dev/null
    git diff --cached --name-only -- "*.${ext}" 2>/dev/null
    git diff --name-only -- "*.${ext}" 2>/dev/null
  } | sort -u | while read -r f; do [[ -f "$f" ]] && echo "$f"; done
}

# Get all modified source files (across all configured extensions).
# Args: $1 = base commit (default HEAD~1)
sharingan_get_all_modified_source() {
  local base="${1:-HEAD~1}"
  local files=""
  local exts
  exts=$(sharingan_get_all_extensions)
  for ext in $exts; do
    files="$files$(sharingan_get_modified_files "$ext" "$base")"$'\n'
  done
  echo "$files" | sort -u | grep -v '^$' | grep -v '/generated/'
}
