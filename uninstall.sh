#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dojutsu Multi-Agent Uninstaller
#
# Removes all 5 skill symlinks from all 4 supported agents.
# Only removes symlinks that point back to this plugin. Safe to re-run.
# Also cleans up agent-mux config if present.
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

print_header()  { printf "\n${BOLD}${BLUE}=== %s ===${RESET}\n\n" "$1"; }
print_step()    { printf "  ${CYAN}=>  ${RESET}%s\n" "$1"; }
print_success() { printf "  ${GREEN} OK ${RESET} %s\n" "$1"; }
print_error()   { printf "  ${RED}ERR ${RESET} %s\n" "$1"; }
print_warn()    { printf "  ${YELLOW} !  ${RESET} %s\n" "$1"; }
print_info()    { printf "  ${DIM}     %s${RESET}\n" "$1"; }

# ── Agent registry (must match setup.sh) ──────────────────────────────────
AGENT_REGISTRY=(
    "Claude Code|claude|${HOME}/.claude/commands"
    "Codex|codex|${HOME}/.codex/skills"
    "OpenCode|opencode|${HOME}/.config/opencode/command"
    "Gemini CLI|gemini|${HOME}/.gemini/skills"
)

# ── Scan all 4 agents for installed dojutsu skills ───────────────────────
print_header "Dojutsu Uninstaller"

printf "  Scanning all agent skill directories for dojutsu symlinks...\n\n"

INSTALLED_AGENTS=()

for i in "${!AGENT_REGISTRY[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$i]}"

    has_links=false
    link_count=0
    for skill in "${SKILLS[@]}"; do
        dest="$skill_dir/$skill"
        if [ -L "$dest" ]; then
            link_target="$(readlink "$dest")"
            if [[ "$link_target" == "$SKILLS_SRC"* ]]; then
                has_links=true
                link_count=$((link_count + 1))
            fi
        fi
    done

    if $has_links; then
        INSTALLED_AGENTS+=("$i")
        print_success "$label  ($link_count skill(s) found)"
    else
        print_info "$label  (no dojutsu skills installed)"
    fi
done

# Check for agent-mux config
MUX_CONFIG_FILE="$HOME/.agent-mux/config.toml"
HAS_MUX_CONFIG=false
if [ -f "$MUX_CONFIG_FILE" ]; then
    if grep -q "dojutsu" "$MUX_CONFIG_FILE" 2>/dev/null; then
        HAS_MUX_CONFIG=true
        print_success "agent-mux config  (dojutsu config found at $MUX_CONFIG_FILE)"
    fi
fi

if [ ${#INSTALLED_AGENTS[@]} -eq 0 ] && ! $HAS_MUX_CONFIG; then
    printf "\n"
    print_step "No dojutsu installations found anywhere. Nothing to remove."
    printf "\n"
    exit 0
fi

# ── Confirm removal ──────────────────────────────────────────────────────
printf "\n"
read -rp "  Remove dojutsu from all the above? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    print_step "Cancelled. Nothing was removed."
    exit 0
fi

# ── Remove skill symlinks from all agents ────────────────────────────────
REMOVED=0
SKIPPED=0

for agent_i in "${INSTALLED_AGENTS[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$agent_i]}"

    print_header "Removing from $label"

    for skill in "${SKILLS[@]}"; do
        dest="$skill_dir/$skill"

        if [ -L "$dest" ]; then
            link_target="$(readlink "$dest")"
            if [[ "$link_target" == "$SKILLS_SRC"* ]]; then
                rm "$dest"
                print_success "Removed $skill"
                REMOVED=$((REMOVED + 1))
            else
                print_warn "Skipped $skill (symlink points to $link_target, not ours)"
                SKIPPED=$((SKIPPED + 1))
            fi
        elif [ -d "$dest" ]; then
            print_warn "Skipped $skill (directory, not a symlink -- remove manually if needed)"
            SKIPPED=$((SKIPPED + 1))
        elif [ -e "$dest" ]; then
            print_warn "Skipped $skill (file, not a symlink -- remove manually if needed)"
            SKIPPED=$((SKIPPED + 1))
        else
            print_info "$skill already absent"
        fi
    done

    # Clean up empty skill directory (only if we emptied it)
    if [ -d "$skill_dir" ]; then
        remaining=$(find "$skill_dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
        if [ "$remaining" -eq 0 ]; then
            rmdir "$skill_dir" 2>/dev/null && \
                print_info "Removed empty directory: $skill_dir" || true
        fi
    fi
done

# ── Remove agent-mux config if present ───────────────────────────────────
if $HAS_MUX_CONFIG; then
    print_header "Cleaning Up Agent-Mux Config"

    backup="${MUX_CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$MUX_CONFIG_FILE" "$backup"
    print_success "Backed up and removed agent-mux config"
    print_info "Backup saved to: $backup"

    # Remove directory if empty
    MUX_DIR="$(dirname "$MUX_CONFIG_FILE")"
    if [ -d "$MUX_DIR" ]; then
        remaining=$(find "$MUX_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
        if [ "$remaining" -eq 0 ]; then
            rmdir "$MUX_DIR" 2>/dev/null && \
                print_info "Removed empty directory: $MUX_DIR" || true
        fi
    fi
fi

# ── Summary ──────────────────────────────────────────────────────────────
print_header "Uninstall Complete"

printf "  ${GREEN}%d${RESET} symlinks removed" "$REMOVED"
if [ "$SKIPPED" -gt 0 ]; then
    printf ", ${YELLOW}%d${RESET} skipped" "$SKIPPED"
fi
if $HAS_MUX_CONFIG; then
    printf ", agent-mux config backed up"
fi
printf "\n\n"

printf "  Plugin source remains at: ${BOLD}%s${RESET}\n" "$SCRIPT_DIR"
printf "  To fully remove the plugin, delete that directory.\n"
printf "  To reinstall later:  ${CYAN}./setup.sh${RESET}\n"
printf "\n"
