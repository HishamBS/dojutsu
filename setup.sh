#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dojutsu Interactive Installer (v2)
#
# Two-mode installer:
#   [1] Agent-Mux mode  -- distributes work across multiple detected engines
#   [2] Native mode     -- uses current agent only with MODEL tier hints
#
# Re-running is safe (idempotent). Existing non-symlink dirs are backed up.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
DOJUTSU_TOML="$SKILLS_SRC/dojutsu/dojutsu.toml"
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

print_header()  { printf "\n${BOLD}${BLUE}=== %s ===${RESET}\n\n" "$1"; }
print_step()    { printf "  ${CYAN}=>  ${RESET}%s\n" "$1"; }
print_success() { printf "  ${GREEN} OK ${RESET} %s\n" "$1"; }
print_error()   { printf "  ${RED}ERR ${RESET} %s\n" "$1"; }
print_warn()    { printf "  ${YELLOW} !  ${RESET} %s\n" "$1"; }
print_info()    { printf "  ${DIM}     %s${RESET}\n" "$1"; }

# ── Agent registry ────────────────────────────────────────────────────────
# Each entry: "label|command|skill_dir"
AGENT_REGISTRY=(
    "Claude Code|claude|${HOME}/.claude/commands"
    "Codex|codex|${HOME}/.codex/skills"
    "OpenCode|opencode|${HOME}/.config/opencode/command"
    "Gemini CLI|gemini|${HOME}/.gemini/skills"
)

# ── Cost estimates per mode ───────────────────────────────────────────────
COST_NATIVE_LOW="0.08"
COST_NATIVE_HIGH="0.25"
COST_MUX_LOW="0.04"
COST_MUX_HIGH="0.15"

# ── Helper: detect platform ──────────────────────────────────────────────
detect_platform() {
    local uname_s
    uname_s="$(uname -s)"
    case "$uname_s" in
        Darwin) echo "macos" ;;
        Linux)
            if grep -qi microsoft /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        *)      echo "unknown" ;;
    esac
}

# ── Helper: detect Linux package manager ─────────────────────────────────
detect_linux_pkg_mgr() {
    if command -v apt &>/dev/null; then
        echo "apt"
    elif command -v dnf &>/dev/null; then
        echo "dnf"
    else
        echo "unknown"
    fi
}

# ── Helper: update dojutsu.toml dispatch section ─────────────────────────
update_toml_dispatch() {
    local mode="$1"
    local default_engine="$2"
    local available_engines_toml="$3"
    local verifier_engine="$4"

    if [ ! -f "$DOJUTSU_TOML" ]; then
        print_warn "dojutsu.toml not found at $DOJUTSU_TOML -- skipping config update"
        return
    fi

    # Use a temp file for safe in-place editing
    local tmp_file
    tmp_file="$(mktemp)"

    local in_dispatch=false
    local dispatch_written=false

    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^\[dispatch\] ]]; then
            in_dispatch=true
            # Write the new dispatch section
            printf '[dispatch]\n' >> "$tmp_file"
            printf 'mode = "%s"                     # "native" or "agent-mux" -- set by setup.sh\n' "$mode" >> "$tmp_file"
            printf 'default_engine = "%s"           # which engine the user is running in\n' "$default_engine" >> "$tmp_file"
            printf 'available_engines = %s      # detected by setup.sh\n' "$available_engines_toml" >> "$tmp_file"
            printf 'verifier_engine = "%s"          # auto-selected: different from default_engine when possible\n' "$verifier_engine" >> "$tmp_file"
            dispatch_written=true
            continue
        fi

        if $in_dispatch; then
            # Skip old dispatch lines until we hit the next section or EOF
            if [[ "$line" =~ ^\[.+\] ]]; then
                in_dispatch=false
                printf '%s\n' "$line" >> "$tmp_file"
            fi
            # Otherwise skip the old line
            continue
        fi

        printf '%s\n' "$line" >> "$tmp_file"
    done < "$DOJUTSU_TOML"

    if ! $dispatch_written; then
        # No [dispatch] section existed -- append one
        printf '\n[dispatch]\n' >> "$tmp_file"
        printf 'mode = "%s"\n' "$mode" >> "$tmp_file"
        printf 'default_engine = "%s"\n' "$default_engine" >> "$tmp_file"
        printf 'available_engines = %s\n' "$available_engines_toml" >> "$tmp_file"
        printf 'verifier_engine = "%s"\n' "$verifier_engine" >> "$tmp_file"
    fi

    mv "$tmp_file" "$DOJUTSU_TOML"
    print_success "Updated dojutsu.toml  (dispatch.mode = \"$mode\")"
}

# ═══════════════════════════════════════════════════════════════════════════
#  MAIN INSTALLER FLOW
# ═══════════════════════════════════════════════════════════════════════════

print_header "Dojutsu Installer"

printf "  Welcome! This will set up the Dojutsu quality pipeline on your machine.\n"
printf "  It takes about a minute. Let's get started.\n\n"

# ── Step 1: Prerequisite checks ──────────────────────────────────────────
print_header "Checking Prerequisites"

# Python 3.9+
if ! command -v python3 &>/dev/null; then
    print_error "python3 is not installed."
    print_info "Install it with your package manager, e.g.:  brew install python@3.12"
    exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
    print_error "Python 3.9+ is required (you have $PY_VERSION)."
    print_info "Upgrade with:  brew install python@3.12  (macOS) or your package manager."
    exit 1
fi
print_success "Python $PY_VERSION"

# git
if ! command -v git &>/dev/null; then
    print_error "git is not installed."
    print_info "Install with:  brew install git  (macOS) or your package manager."
    exit 1
fi
print_success "git $(git --version | awk '{print $3}')"

# ── Step 2: Detect available coding agents ───────────────────────────────
print_header "Detecting Coding Agents"

DETECTED_INDICES=()
DETECTED_LABELS=()
DETECTED_CMDS=()

for i in "${!AGENT_REGISTRY[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$i]}"
    if command -v "$cmd" &>/dev/null; then
        DETECTED_INDICES+=("$i")
        DETECTED_LABELS+=("$label")
        DETECTED_CMDS+=("$cmd")
        print_success "$label  ($cmd found in PATH)"
    else
        print_info "$label  ($cmd not found -- will skip)"
    fi
done

if [ ${#DETECTED_INDICES[@]} -eq 0 ]; then
    print_warn "No supported coding agents were detected on your PATH."
    print_info "Dojutsu works with: claude, codex, opencode, or gemini."
    printf "\n"
    read -rp "  Install skill symlinks for all agents anyway? [y/N] " FORCE_ALL
    if [[ ! "$FORCE_ALL" =~ ^[Yy] ]]; then
        print_step "Nothing installed. Come back when you have an agent on PATH!"
        exit 0
    fi
    # Treat all agents as detected
    for i in "${!AGENT_REGISTRY[@]}"; do
        DETECTED_INDICES+=("$i")
        IFS='|' read -r label cmd _ <<< "${AGENT_REGISTRY[$i]}"
        DETECTED_LABELS+=("$label")
        DETECTED_CMDS+=("$cmd")
    done
fi

# Build TOML-formatted available_engines list
AVAILABLE_ENGINES_TOML="["
FIRST_ENGINE=""
for cmd in "${DETECTED_CMDS[@]}"; do
    if [ -n "$FIRST_ENGINE" ]; then
        AVAILABLE_ENGINES_TOML+=", "
    fi
    AVAILABLE_ENGINES_TOML+="\"$cmd\""
    if [ -z "$FIRST_ENGINE" ]; then
        FIRST_ENGINE="$cmd"
    fi
done
AVAILABLE_ENGINES_TOML+="]"

# Pick a verifier engine (prefer one different from the default)
VERIFIER_ENGINE="$FIRST_ENGINE"
for cmd in "${DETECTED_CMDS[@]}"; do
    if [ "$cmd" != "$FIRST_ENGINE" ]; then
        VERIFIER_ENGINE="$cmd"
        break
    fi
done

# ── Step 3: Mode selection ───────────────────────────────────────────────
print_header "Choose Installation Mode"

printf "  Dojutsu can run in two modes:\n\n"
printf "  ${BOLD}[1] Agent-Mux mode${RESET}\n"
printf "      Distributes work across all detected engines for speed and cost savings.\n"
printf "      Requires agent-mux (Go binary). We'll help you install it if needed.\n"
printf "      Estimated cost per full run: ${GREEN}\$%s -- \$%s${RESET}\n\n" "$COST_MUX_LOW" "$COST_MUX_HIGH"

printf "  ${BOLD}[2] Native mode${RESET}\n"
printf "      Uses your current agent only, with Haiku/Sonnet/Opus model tier hints.\n"
printf "      No extra dependencies needed. Simpler, but single-engine.\n"
printf "      Estimated cost per full run: ${GREEN}\$%s -- \$%s${RESET}\n\n" "$COST_NATIVE_LOW" "$COST_NATIVE_HIGH"

if [ ${#DETECTED_INDICES[@]} -lt 2 ]; then
    print_info "Tip: Only one agent detected. Native mode is the simpler choice."
fi

read -rp "  Enter your choice [1/2]: " MODE_CHOICE

case "$MODE_CHOICE" in
    1) INSTALL_MODE="agent-mux" ;;
    2) INSTALL_MODE="native" ;;
    *)
        print_warn "Invalid choice. Defaulting to Native mode."
        INSTALL_MODE="native"
        ;;
esac

print_success "Selected mode: $INSTALL_MODE"

# ── Step 4a: Agent-Mux mode flow ─────────────────────────────────────────
if [ "$INSTALL_MODE" = "agent-mux" ]; then
    print_header "Setting Up Agent-Mux"

    AGENT_MUX_READY=false

    # Check if agent-mux is already on PATH
    if command -v agent-mux &>/dev/null; then
        print_success "agent-mux already installed ($(command -v agent-mux))"
        AGENT_MUX_READY=true
    else
        print_step "agent-mux not found on PATH. Let's install it."

        # Check for Go
        if command -v go &>/dev/null; then
            GO_VERSION=$(go version | awk '{print $3}')
            print_success "Go found ($GO_VERSION)"
        else
            print_step "Go is not installed. Let's fix that."

            PLATFORM=$(detect_platform)
            case "$PLATFORM" in
                macos)
                    if command -v brew &>/dev/null; then
                        printf "\n"
                        read -rp "  Install Go via Homebrew? [Y/n] " INSTALL_GO
                        if [[ ! "$INSTALL_GO" =~ ^[Nn] ]]; then
                            print_step "Running: brew install go"
                            brew install go
                            print_success "Go installed via Homebrew"
                        else
                            print_info "You can install Go manually from: https://go.dev/dl/"
                            print_warn "Cannot build agent-mux without Go. Falling back to Native mode."
                            INSTALL_MODE="native"
                        fi
                    else
                        print_info "Homebrew not found. Please install Go from: https://go.dev/dl/"
                        print_info "After installing Go, re-run this setup."
                        print_warn "Falling back to Native mode for now."
                        INSTALL_MODE="native"
                    fi
                    ;;
                linux)
                    PKG_MGR=$(detect_linux_pkg_mgr)
                    case "$PKG_MGR" in
                        apt)
                            printf "\n"
                            read -rp "  Install Go via apt? [Y/n] " INSTALL_GO
                            if [[ ! "$INSTALL_GO" =~ ^[Nn] ]]; then
                                print_step "Running: sudo apt update && sudo apt install -y golang-go"
                                sudo apt update && sudo apt install -y golang-go
                                print_success "Go installed via apt"
                            else
                                print_info "Install Go from: https://go.dev/dl/"
                                print_warn "Falling back to Native mode."
                                INSTALL_MODE="native"
                            fi
                            ;;
                        dnf)
                            printf "\n"
                            read -rp "  Install Go via dnf? [Y/n] " INSTALL_GO
                            if [[ ! "$INSTALL_GO" =~ ^[Nn] ]]; then
                                print_step "Running: sudo dnf install -y golang"
                                sudo dnf install -y golang
                                print_success "Go installed via dnf"
                            else
                                print_info "Install Go from: https://go.dev/dl/"
                                print_warn "Falling back to Native mode."
                                INSTALL_MODE="native"
                            fi
                            ;;
                        *)
                            print_info "Could not detect your package manager."
                            print_info "Install Go from: https://go.dev/dl/"
                            print_warn "Falling back to Native mode."
                            INSTALL_MODE="native"
                            ;;
                    esac
                    ;;
                wsl)
                    printf "\n"
                    read -rp "  Install Go via apt (WSL)? [Y/n] " INSTALL_GO
                    if [[ ! "$INSTALL_GO" =~ ^[Nn] ]]; then
                        print_step "Running: sudo apt update && sudo apt install -y golang-go"
                        sudo apt update && sudo apt install -y golang-go
                        print_success "Go installed via apt (WSL)"
                    else
                        print_info "Install Go from: https://go.dev/dl/"
                        print_warn "Falling back to Native mode."
                        INSTALL_MODE="native"
                    fi
                    ;;
                *)
                    print_info "Unrecognized platform. Install Go from: https://go.dev/dl/"
                    print_warn "Falling back to Native mode."
                    INSTALL_MODE="native"
                    ;;
            esac
        fi

        # If we still have agent-mux mode and Go is available, build agent-mux
        if [ "$INSTALL_MODE" = "agent-mux" ] && command -v go &>/dev/null; then
            print_step "Building agent-mux from source..."

            BUILD_DIR="/tmp/agent-mux-build"
            rm -rf "$BUILD_DIR"

            if git clone https://github.com/buildoak/agent-mux "$BUILD_DIR" 2>/dev/null; then
                if (cd "$BUILD_DIR" && go build -o agent-mux ./cmd/agent-mux); then
                    # Install to ~/bin
                    INSTALL_DIR="$HOME/bin"
                    mkdir -p "$INSTALL_DIR"
                    mv "$BUILD_DIR/agent-mux" "$INSTALL_DIR/agent-mux"
                    chmod +x "$INSTALL_DIR/agent-mux"
                    print_success "agent-mux installed to $INSTALL_DIR/agent-mux"

                    # Check if ~/bin is on PATH
                    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
                        print_warn "~/bin is not on your PATH."
                        print_info "Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
                        print_info "  export PATH=\"\$HOME/bin:\$PATH\""
                    fi

                    AGENT_MUX_READY=true
                else
                    print_error "agent-mux build failed."
                    print_warn "Falling back to Native mode."
                    INSTALL_MODE="native"
                fi
            else
                print_error "Could not clone agent-mux repository."
                print_warn "Falling back to Native mode."
                INSTALL_MODE="native"
            fi

            rm -rf "$BUILD_DIR"
        fi
    fi

    # Generate agent-mux config if ready
    if $AGENT_MUX_READY; then
        MUX_CONFIG_DIR="$HOME/.agent-mux"
        MUX_CONFIG_FILE="$MUX_CONFIG_DIR/config.toml"

        mkdir -p "$MUX_CONFIG_DIR"

        print_step "Generating agent-mux config..."

        {
            printf '# agent-mux config -- generated by dojutsu setup.sh\n'
            printf '# Maps dojutsu pipeline roles to detected engines.\n\n'
            printf '[defaults]\n'
            printf 'timeout = 600\n'
            printf 'retry = 1\n\n'

            # Build roles: scanners go to cheapest, enrichers to mid, narrators to premium
            # Distribute across detected engines round-robin style
            ENGINE_COUNT=${#DETECTED_CMDS[@]}

            printf '# Scanner roles -- high volume, low cost\n'
            printf '[[roles]]\n'
            printf 'name = "scanner"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[0]}"
            printf 'model_tier = "cheap"\n'
            printf 'timeout = 600\n\n'

            printf '[[roles]]\n'
            printf 'name = "aggregator"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[0]}"
            printf 'model_tier = "cheap"\n'
            printf 'timeout = 600\n\n'

            # Mid-tier roles -- distribute across engines
            mid_idx=0
            if [ "$ENGINE_COUNT" -gt 1 ]; then
                mid_idx=1
            fi

            printf '# Mid-tier roles -- code understanding\n'
            printf '[[roles]]\n'
            printf 'name = "enricher"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[$mid_idx]}"
            printf 'model_tier = "mid"\n'
            printf 'timeout = 600\n\n'

            printf '[[roles]]\n'
            printf 'name = "fixer"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[$mid_idx]}"
            printf 'model_tier = "mid"\n'
            printf 'timeout = 600\n\n'

            verifier_idx=0
            if [ "$ENGINE_COUNT" -gt 1 ]; then
                verifier_idx=$(( (mid_idx + 1) % ENGINE_COUNT ))
            fi

            printf '[[roles]]\n'
            printf 'name = "verifier"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[$verifier_idx]}"
            printf 'model_tier = "mid"\n'
            printf 'timeout = 1200\n\n'

            # Premium roles -- keep on first engine (usually the one the user trusts most)
            printf '# Premium roles -- high-quality output\n'
            printf '[[roles]]\n'
            printf 'name = "narrator"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[0]}"
            printf 'model_tier = "premium"\n'
            printf 'timeout = 1800\n\n'

            printf '[[roles]]\n'
            printf 'name = "master_hub_generator"\n'
            printf 'engine = "%s"\n' "${DETECTED_CMDS[0]}"
            printf 'model_tier = "premium"\n'
            printf 'timeout = 1800\n'
        } > "$MUX_CONFIG_FILE"

        print_success "Generated $MUX_CONFIG_FILE"
    fi
fi

# ── Step 4b: Update dojutsu.toml with chosen mode ────────────────────────
print_header "Updating Configuration"

update_toml_dispatch "$INSTALL_MODE" "$FIRST_ENGINE" "$AVAILABLE_ENGINES_TOML" "$VERIFIER_ENGINE"

# ── Step 5: Install skill symlinks ───────────────────────────────────────
print_header "Installing Skills"

printf "  Installing 5 skills into each detected agent's skill directory.\n\n"

INSTALL_COUNT=0
FAIL_COUNT=0

for agent_i in "${DETECTED_INDICES[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"

    print_step "Installing for $label  ($skill_dir)"

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
            # Points somewhere else -- remove stale symlink and re-link
            rm "$dest"
            print_info "Replaced stale symlink for $skill"
        elif [ -d "$dest" ]; then
            backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
            print_warn "$skill exists as a directory -- backed up to $(basename "$backup")"
            mv "$dest" "$backup"
        elif [ -e "$dest" ]; then
            backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
            print_warn "$skill exists as a file -- backed up to $(basename "$backup")"
            mv "$dest" "$backup"
        fi

        ln -s "$src" "$dest"
        print_success "$skill"
        INSTALL_COUNT=$((INSTALL_COUNT + 1))
    done

    printf "\n"
done

# ── Step 6: chmod +x all .sh files ───────────────────────────────────────
print_header "Setting Permissions"

find "$SCRIPT_DIR" -name "*.sh" -exec chmod +x {} \;
print_success "All .sh files in the plugin are now executable."

# ── Step 7: Self-test (pytest on rinnegan + rasengan) ─────────────────────
print_header "Running Self-Tests"

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

TESTS_PASSED=true
if [ ${#TEST_DIRS[@]} -gt 0 ]; then
    for test_dir in "${TEST_DIRS[@]}"; do
        test_label="$(basename "$(dirname "$test_dir")")/tests"
        print_step "Running pytest on $test_label..."
        if python3 -m pytest "$test_dir" -q 2>/dev/null; then
            print_success "$test_label passed"
        else
            print_warn "$test_label had failures (skills are installed but may need attention)"
            TESTS_PASSED=false
        fi
    done
else
    print_info "No test directories found -- skipping self-tests."
fi

# ── Step 8: Verification (SKILL.md readable through symlinks) ────────────
print_header "Verifying Symlinks"

VERIFY_PASS=0
VERIFY_FAIL=0

for agent_i in "${DETECTED_INDICES[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"

    for skill in "${SKILLS[@]}"; do
        dest="$skill_dir/$skill"

        # Look for SKILL.md (case-insensitive) or CLAUDE.md
        skill_md=""
        if [ -f "$dest/SKILL.md" ]; then
            skill_md="$dest/SKILL.md"
        elif [ -f "$dest/skill.md" ]; then
            skill_md="$dest/skill.md"
        elif [ -f "$dest/CLAUDE.md" ]; then
            skill_md="$dest/CLAUDE.md"
        fi

        if [ -n "$skill_md" ] && [ -r "$skill_md" ]; then
            VERIFY_PASS=$((VERIFY_PASS + 1))
        elif [ -L "$dest" ] && [ -d "$dest" ]; then
            # Symlink exists and resolves to a directory, but no markdown found
            print_warn "$label/$skill -- no SKILL.md found (non-critical)"
            VERIFY_PASS=$((VERIFY_PASS + 1))
        else
            print_error "$label/$skill -- symlink broken or missing"
            VERIFY_FAIL=$((VERIFY_FAIL + 1))
        fi
    done
done

if [ "$VERIFY_FAIL" -eq 0 ]; then
    print_success "All ${VERIFY_PASS} skill symlinks verified and readable."
else
    print_warn "${VERIFY_PASS} verified, ${VERIFY_FAIL} failed -- check errors above."
fi

# ── Summary ──────────────────────────────────────────────────────────────
print_header "Installation Complete"

printf "  ${BOLD}Mode:${RESET}   %s\n" "$INSTALL_MODE"
printf "  ${BOLD}Skills:${RESET} %d installed across %d agent(s)" \
    "$INSTALL_COUNT" "${#DETECTED_INDICES[@]}"
if [ "$FAIL_COUNT" -gt 0 ]; then
    printf "  ${RED}(%d failed)${RESET}" "$FAIL_COUNT"
fi
printf "\n"

if [ "$INSTALL_MODE" = "agent-mux" ]; then
    printf "  ${BOLD}Engines:${RESET} %s\n" "$AVAILABLE_ENGINES_TOML"
fi

printf "\n"
printf "  ${BOLD}Estimated cost per full pipeline run:${RESET}\n"
if [ "$INSTALL_MODE" = "agent-mux" ]; then
    printf "    ${GREEN}\$%s -- \$%s${RESET}  (multi-engine, optimized routing)\n" "$COST_MUX_LOW" "$COST_MUX_HIGH"
else
    printf "    ${GREEN}\$%s -- \$%s${RESET}  (single-engine, tier-based model hints)\n" "$COST_NATIVE_LOW" "$COST_NATIVE_HIGH"
fi

printf "\n"
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
