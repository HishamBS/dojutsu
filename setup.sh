#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dojutsu Multi-Agent Installer
# Installs skill symlinks into one or more coding-agent skill directories.
# Re-running is safe (idempotent). Existing non-symlink dirs are backed up.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
SKILLS=(rinnegan byakugan rasengan sharingan dojutsu)

# ── Colour helpers ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

print_header()  { printf "\n${BOLD}${BLUE}%s${RESET}\n" "$1"; }
print_step()    { printf "  ${CYAN}=>  ${RESET}%s\n" "$1"; }
print_success() { printf "  ${GREEN}OK  ${RESET}%s\n" "$1"; }
print_error()   { printf "  ${RED}ERR ${RESET}%s\n" "$1"; }
print_warn()    { printf "  ${YELLOW}!   ${RESET}%s\n" "$1"; }
print_info()    { printf "  ${DIM}    %s${RESET}\n" "$1"; }

# ── Agent registry ────────────────────────────────────────────────────────
# Each entry: "label|command|skill_dir"
AGENT_REGISTRY=(
    "Claude Code|claude|${HOME}/.claude/commands"
    "Codex|codex|${HOME}/.codex/skills"
    "OpenCode|opencode|${HOME}/.config/opencode/command"
    "Gemini|gemini|${HOME}/.gemini/skills"
)

# ── Prerequisite checks ──────────────────────────────────────────────────
print_header "Dojutsu Installer"
printf "\n"

print_step "Checking prerequisites..."

# Python 3.9+
if ! command -v python3 &>/dev/null; then
    print_error "python3 not found. Install with:  brew install python@3.12"
    exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
    print_error "Python 3.9+ required (found $PY_VERSION)"
    exit 1
fi
print_success "Python $PY_VERSION"

# git
if ! command -v git &>/dev/null; then
    print_error "git not found. Install with:  brew install git"
    exit 1
fi
print_success "git $(git --version | awk '{print $3}')"

# bash
if ! command -v bash &>/dev/null; then
    print_error "bash not found"
    exit 1
fi
BASH_VER=$(bash --version | head -1 | sed 's/.*version \([0-9][0-9.]*\).*/\1/')
print_success "bash $BASH_VER"

# ── Detect available agents ──────────────────────────────────────────────
print_header "Detecting coding agents"

DETECTED_INDICES=()
for i in "${!AGENT_REGISTRY[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$i]}"
    if command -v "$cmd" &>/dev/null; then
        DETECTED_INDICES+=("$i")
        print_success "$label  ($cmd found)"
    else
        print_info "$label  ($cmd not found -- skipped)"
    fi
done

if [ ${#DETECTED_INDICES[@]} -eq 0 ]; then
    print_warn "No supported coding agents detected on PATH."
    print_warn "You can still install manually by ensuring one of these is available:"
    for entry in "${AGENT_REGISTRY[@]}"; do
        IFS='|' read -r label cmd _ <<< "$entry"
        print_info "  $cmd  ($label)"
    done
    printf "\n"
    read -rp "  Install anyway for all agents? [y/N] " FORCE_ALL
    if [[ ! "$FORCE_ALL" =~ ^[Yy] ]]; then
        print_step "Nothing installed. Exiting."
        exit 0
    fi
    # Treat all agents as selected
    DETECTED_INDICES=()
    for i in "${!AGENT_REGISTRY[@]}"; do
        DETECTED_INDICES+=("$i")
    done
fi

# ── Interactive selection ────────────────────────────────────────────────
print_header "Select agents to install"

printf "\n"
for idx in "${!DETECTED_INDICES[@]}"; do
    agent_i="${DETECTED_INDICES[$idx]}"
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"
    num=$((idx + 1))
    printf "  ${BOLD}%d)${RESET} %s  ${DIM}(%s)${RESET}\n" "$num" "$label" "$skill_dir"
done
printf "  ${BOLD}a)${RESET} All of the above\n"
printf "\n"

read -rp "  Enter choice (numbers separated by spaces, or 'a' for all): " SELECTION

SELECTED_INDICES=()
if [[ "$SELECTION" =~ ^[Aa] ]]; then
    SELECTED_INDICES=("${DETECTED_INDICES[@]}")
else
    for token in $SELECTION; do
        if [[ "$token" =~ ^[0-9]+$ ]]; then
            arr_idx=$((token - 1))
            if [ "$arr_idx" -ge 0 ] && [ "$arr_idx" -lt "${#DETECTED_INDICES[@]}" ]; then
                SELECTED_INDICES+=("${DETECTED_INDICES[$arr_idx]}")
            else
                print_warn "Ignoring invalid selection: $token"
            fi
        else
            print_warn "Ignoring non-numeric input: $token"
        fi
    done
fi

if [ ${#SELECTED_INDICES[@]} -eq 0 ]; then
    print_step "No agents selected. Nothing to install."
    exit 0
fi

# ── Install skills into each selected agent ──────────────────────────────
INSTALL_COUNT=0
FAIL_COUNT=0

for agent_i in "${SELECTED_INDICES[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"

    print_header "Installing for $label"
    print_info "Target: $skill_dir"

    mkdir -p "$skill_dir"

    for skill in "${SKILLS[@]}"; do
        src="$SKILLS_SRC/$skill"
        dest="$skill_dir/$skill"

        if [ ! -d "$src" ]; then
            print_error "Source missing: $src"
            FAIL_COUNT=$((FAIL_COUNT + 1))
            continue
        fi

        # Idempotent handling
        if [ -L "$dest" ]; then
            existing_target="$(readlink "$dest")"
            if [ "$existing_target" = "$src" ]; then
                print_success "$skill  (already linked)"
                INSTALL_COUNT=$((INSTALL_COUNT + 1))
                continue
            fi
            # Points somewhere else -- remove and re-link
            rm "$dest"
        elif [ -d "$dest" ]; then
            backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
            print_warn "$skill exists as directory -- backing up to $(basename "$backup")"
            mv "$dest" "$backup"
        elif [ -e "$dest" ]; then
            backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
            print_warn "$skill exists as file -- backing up to $(basename "$backup")"
            mv "$dest" "$backup"
        fi

        ln -s "$src" "$dest"
        print_success "Installing $skill... done"
        INSTALL_COUNT=$((INSTALL_COUNT + 1))
    done
done

# ── Make all .sh files executable ────────────────────────────────────────
print_header "Post-install"

find "$SCRIPT_DIR" -name "*.sh" -exec chmod +x {} \;
print_success "All .sh files marked executable"

# ── Verification: check SKILL.md accessibility ───────────────────────────
print_header "Verifying installation"

VERIFY_PASS=0
VERIFY_FAIL=0

for agent_i in "${SELECTED_INDICES[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"

    for skill in "${SKILLS[@]}"; do
        dest="$skill_dir/$skill"
        # Check for SKILL.md (case-insensitive check)
        skill_md=""
        if [ -f "$dest/SKILL.md" ]; then
            skill_md="$dest/SKILL.md"
        elif [ -f "$dest/skill.md" ]; then
            skill_md="$dest/skill.md"
        fi

        if [ -n "$skill_md" ] && [ -r "$skill_md" ]; then
            VERIFY_PASS=$((VERIFY_PASS + 1))
        elif [ -L "$dest" ] && [ -d "$dest" ]; then
            # Skill dir exists but no SKILL.md (sharingan uses skill.md or CLAUDE.md)
            if [ -f "$dest/CLAUDE.md" ] || [ -f "$dest/skill.md" ]; then
                VERIFY_PASS=$((VERIFY_PASS + 1))
            else
                print_warn "$label/$skill -- no SKILL.md found (non-critical)"
                VERIFY_PASS=$((VERIFY_PASS + 1))
            fi
        else
            print_error "$label/$skill -- symlink broken or missing"
            VERIFY_FAIL=$((VERIFY_FAIL + 1))
        fi
    done
done

if [ "$VERIFY_FAIL" -eq 0 ]; then
    print_success "All ${VERIFY_PASS} skill links verified"
else
    print_warn "${VERIFY_PASS} verified, ${VERIFY_FAIL} failed"
fi

# ── Run self-tests ───────────────────────────────────────────────────────
print_header "Running self-tests"

TEST_DIRS=()
for subdir in rinnegan rasengan; do
    test_path="$SKILLS_SRC/$subdir/tests"
    if [ -d "$test_path" ]; then
        TEST_DIRS+=("$test_path")
    fi
done

# Also check top-level tests/
if [ -d "$SCRIPT_DIR/tests" ]; then
    TEST_DIRS+=("$SCRIPT_DIR/tests")
fi

if [ ${#TEST_DIRS[@]} -gt 0 ]; then
    TEST_PASSED=true
    for test_dir in "${TEST_DIRS[@]}"; do
        print_step "pytest $(basename "$(dirname "$test_dir")")/tests/"
        if python3 -m pytest "$test_dir" -q 2>/dev/null; then
            print_success "Tests passed"
        else
            print_warn "Some tests failed (skills are installed but may need attention)"
            TEST_PASSED=false
        fi
    done
else
    print_info "No test directories found -- skipping"
fi

# ── Summary ──────────────────────────────────────────────────────────────
print_header "Installation Complete"

printf "\n"
printf "  ${BOLD}%d${RESET} skills installed across ${BOLD}%d${RESET} agent(s)" \
    "$INSTALL_COUNT" "${#SELECTED_INDICES[@]}"
if [ "$FAIL_COUNT" -gt 0 ]; then
    printf "  ${RED}(%d failed)${RESET}" "$FAIL_COUNT"
fi
printf "\n\n"

printf "  ${BOLD}Available commands:${RESET}\n"
printf "    ${CYAN}/dojutsu${RESET}    Full automated pipeline (audit, analyze, fix, verify)\n"
printf "    ${CYAN}/rinnegan${RESET}   Audit codebase for engineering rule violations\n"
printf "    ${CYAN}/byakugan${RESET}   Deep analysis -- dependencies, blast radius, scorecards\n"
printf "    ${CYAN}/rasengan${RESET}   Autonomously fix audit findings phase by phase\n"
printf "    ${CYAN}/sharingan${RESET}   Evidence-based QA pipeline (6 verification gates)\n"
printf "\n"
printf "  Run ${BOLD}/dojutsu${RESET} in any project to start the full pipeline.\n"
printf "  Run ${BOLD}./uninstall.sh${RESET} to cleanly remove all symlinks.\n"
printf "\n"
