#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dojutsu Tool Installer
#
# Detects and installs the deterministic scanning tools that the rinnegan
# pipeline uses. Tools are grouped by stack. Missing tools degrade the audit
# (fewer findings), so installing all of them is strongly recommended.
#
# Usage:
#   bash install-tools.sh              # interactive (prompts before install)
#   bash install-tools.sh --auto       # non-interactive (installs everything)
#   bash install-tools.sh --check      # report only, no installs
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

AUTO=false
CHECK_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --auto) AUTO=true ;;
        --check) CHECK_ONLY=true ;;
    esac
done

print_ok()   { printf "  ${GREEN} OK ${RESET} %-14s %s\n" "$1" "$2"; }
print_miss() { printf "  ${RED}MISS${RESET} %-14s %s\n" "$1" "$2"; }
print_step() { printf "  ${CYAN}=>  ${RESET}%s\n" "$1"; }
print_warn() { printf "  ${YELLOW} !  ${RESET}%s\n" "$1"; }

MISSING_BREW=()
MISSING_BUN=()
MISSING_UV=()

# ---------------------------------------------------------------------------
# Tool registry: name | check command | install method | install target | description
# ---------------------------------------------------------------------------
TOOLS=(
    # -- Universal (all stacks) --
    "semgrep|semgrep --version|uv|semgrep|SAST scanner (security, bugs)"
    "gitleaks|gitleaks version|brew|gitleaks|Secrets scanner (API keys, tokens)"
    "jscpd|jscpd --version|bun|jscpd|Code duplication detector"

    # -- TypeScript/JavaScript --
    "eslint|eslint --version|bun|eslint|JS/TS linter"
    "typescript|tsc --version|bun|typescript|TypeScript compiler (type checking)"
    "knip|knip --version|bun|knip|Dead exports and unused code detector"
    "madge|madge --version|bun|madge|Circular dependency detector"

    # -- Python --
    "ruff|ruff --version|uv|ruff|Python linter (replaces flake8/pylint)"
    "mypy|mypy --version|uv|mypy|Python type checker"
    "radon|radon --version|uv|radon|Python complexity analyzer"
    "vulture|vulture --version|uv|vulture|Python dead code detector"
    "pip-audit|pip-audit --version|uv|pip-audit|Python dependency vulnerability scanner"
)

# ---------------------------------------------------------------------------
# Detect
# ---------------------------------------------------------------------------
printf "\n${BOLD}Scanning Tool Availability${RESET}\n\n"

TOTAL=0
FOUND=0

for entry in "${TOOLS[@]}"; do
    IFS='|' read -r name check method target desc <<< "$entry"
    TOTAL=$((TOTAL + 1))

    if eval "$check" &>/dev/null; then
        print_ok "$name" "$desc"
        FOUND=$((FOUND + 1))
    else
        print_miss "$name" "$desc"
        case "$method" in
            brew) MISSING_BREW+=("$target") ;;
            bun)  MISSING_BUN+=("$target") ;;
            uv)   MISSING_UV+=("$target") ;;
        esac
    fi
done

printf "\n  ${BOLD}Result: ${FOUND}/${TOTAL} tools available${RESET}\n"

MISSING_TOTAL=$(( ${#MISSING_BREW[@]} + ${#MISSING_BUN[@]} + ${#MISSING_UV[@]} ))

if [ "$MISSING_TOTAL" -eq 0 ]; then
    printf "  ${GREEN}All tools installed. Pipeline will run at full capacity.${RESET}\n\n"
    exit 0
fi

printf "  ${YELLOW}${MISSING_TOTAL} tools missing. Pipeline will skip their checks.${RESET}\n\n"

if $CHECK_ONLY; then
    printf "  Run without --check to install missing tools.\n\n"
    exit 0
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
if ! $AUTO; then
    printf "  Install all ${MISSING_TOTAL} missing tools? [Y/n] "
    read -r REPLY
    if [[ "$REPLY" =~ ^[Nn] ]]; then
        printf "\n  Skipped. You can install them later with:\n"
        printf "  ${DIM}bash install-tools.sh${RESET}\n\n"
        exit 0
    fi
fi

# Homebrew tools
if [ ${#MISSING_BREW[@]} -gt 0 ]; then
    if command -v brew &>/dev/null; then
        print_step "Installing via Homebrew: ${MISSING_BREW[*]}"
        brew install "${MISSING_BREW[@]}" 2>&1 | tail -3
    else
        print_warn "Homebrew not found. Install these manually: ${MISSING_BREW[*]}"
        print_warn "  macOS: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        print_warn "  Then: brew install ${MISSING_BREW[*]}"
    fi
fi

# bun global tools (bun is the only JS/TS package manager)
if [ ${#MISSING_BUN[@]} -gt 0 ]; then
    if command -v bun &>/dev/null; then
        print_step "Installing via bun: ${MISSING_BUN[*]}"
        bun install -g "${MISSING_BUN[@]}" 2>&1 | tail -3
    else
        print_warn "bun not found. Install it (https://bun.sh), then: bun install -g ${MISSING_BUN[*]}"
    fi
fi

# uv tools (isolated Python; uv is the only Python package manager)
if [ ${#MISSING_UV[@]} -gt 0 ]; then
    if command -v uv &>/dev/null; then
        for pkg in "${MISSING_UV[@]}"; do
            print_step "Installing via uv: $pkg"
            uv tool install "$pkg" 2>&1 | tail -1
        done
    else
        print_warn "uv not found. Install it (https://docs.astral.sh/uv/), then: uv tool install <tool> for each of: ${MISSING_UV[*]}"
    fi
fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
printf "\n${BOLD}Verifying Installation${RESET}\n\n"

STILL_MISSING=0
for entry in "${TOOLS[@]}"; do
    IFS='|' read -r name check _ _ desc <<< "$entry"
    if eval "$check" &>/dev/null; then
        print_ok "$name" ""
    else
        print_miss "$name" "still not available"
        STILL_MISSING=$((STILL_MISSING + 1))
    fi
done

if [ "$STILL_MISSING" -eq 0 ]; then
    printf "\n  ${GREEN}All ${TOTAL} tools installed. Pipeline ready.${RESET}\n\n"
else
    printf "\n  ${YELLOW}${STILL_MISSING} tools still missing. Check errors above.${RESET}\n\n"
fi
