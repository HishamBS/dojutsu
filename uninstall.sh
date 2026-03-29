#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Dojutsu Multi-Agent Uninstaller
# Removes only symlinks that point back to this plugin. Safe to re-run.
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

# ── Agent registry (must match setup.sh) ──────────────────────────────────
AGENT_REGISTRY=(
    "Claude Code|claude|${HOME}/.claude/commands"
    "Codex|codex|${HOME}/.codex/skills"
    "OpenCode|opencode|${HOME}/.config/opencode/command"
    "Gemini|gemini|${HOME}/.gemini/skills"
)

# ── Detect which agents have dojutsu installed ───────────────────────────
print_header "Dojutsu Uninstaller"
printf "\n"
print_step "Scanning for installed dojutsu skills..."

INSTALLED_AGENTS=()
for i in "${!AGENT_REGISTRY[@]}"; do
    IFS='|' read -r label cmd skill_dir <<< "${AGENT_REGISTRY[$i]}"

    has_links=false
    for skill in "${SKILLS[@]}"; do
        dest="$skill_dir/$skill"
        if [ -L "$dest" ]; then
            link_target="$(readlink "$dest")"
            if [[ "$link_target" == "$SKILLS_SRC"* ]]; then
                has_links=true
                break
            fi
        fi
    done

    if $has_links; then
        INSTALLED_AGENTS+=("$i")
        print_success "$label  (dojutsu skills found)"
    else
        print_info "$label  (no dojutsu skills)"
    fi
done

if [ ${#INSTALLED_AGENTS[@]} -eq 0 ]; then
    printf "\n"
    print_step "No dojutsu installations found. Nothing to remove."
    printf "\n"
    exit 0
fi

# ── Confirm removal ──────────────────────────────────────────────────────
printf "\n"
read -rp "  Remove dojutsu skills from these agents? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    print_step "Cancelled. Nothing removed."
    exit 0
fi

# ── Remove symlinks ─────────────────────────────────────────────────────
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
                print_warn "Skipped $skill (points to $link_target, not ours)"
                SKIPPED=$((SKIPPED + 1))
            fi
        elif [ -d "$dest" ]; then
            print_warn "Skipped $skill (directory, not a symlink -- manual removal needed)"
            SKIPPED=$((SKIPPED + 1))
        elif [ -e "$dest" ]; then
            print_warn "Skipped $skill (file, not a symlink -- manual removal needed)"
            SKIPPED=$((SKIPPED + 1))
        else
            print_info "$skill already absent"
        fi
    done

    # Clean up empty skill directory (only if we created it)
    if [ -d "$skill_dir" ]; then
        remaining=$(find "$skill_dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
        if [ "$remaining" -eq 0 ]; then
            rmdir "$skill_dir" 2>/dev/null && \
                print_info "Removed empty directory: $skill_dir" || true
        fi
    fi
done

# ── Summary ──────────────────────────────────────────────────────────────
print_header "Uninstall Complete"

printf "\n"
printf "  ${GREEN}%d${RESET} symlinks removed" "$REMOVED"
if [ "$SKIPPED" -gt 0 ]; then
    printf ", ${YELLOW}%d${RESET} skipped" "$SKIPPED"
fi
printf "\n\n"

printf "  Plugin source remains at: ${BOLD}%s${RESET}\n" "$SCRIPT_DIR"
printf "  To fully remove, delete that directory.\n"
printf "  To reinstall later:  ${CYAN}./setup.sh${RESET}\n"
printf "\n"
