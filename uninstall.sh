#!/usr/bin/env bash
set -euo pipefail

SKILLS_DIR="${HOME}/.coding-agent/skills"
SHARINGAN_LINK="${HOME}/.config/spsm/sharingan"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Dojutsu Pipeline Uninstaller ==="
echo ""

# 1. Remove skill symlinks (only if they point to this plugin)
for skill in rinnegan rasengan sharingan byakugan dojutsu; do
    target="$SKILLS_DIR/$skill"
    if [ -L "$target" ]; then
        link_target="$(readlink "$target")"
        if [[ "$link_target" == *"$SCRIPT_DIR"* ]]; then
            rm "$target"
            echo "Removed /$skill"
        else
            echo "Skipped /$skill (points elsewhere: $link_target)"
        fi
    elif [ -d "$target" ]; then
        echo "Skipped /$skill (not a symlink, manual removal needed)"
    fi
done

# 2. Remove sharingan core symlink
if [ -L "$SHARINGAN_LINK" ]; then
    link_target="$(readlink "$SHARINGAN_LINK")"
    if [[ "$link_target" == *"$SCRIPT_DIR"* ]]; then
        rm "$SHARINGAN_LINK"
        echo "Removed sharingan core link"
    fi
fi

echo ""
echo "=== Uninstall Complete ==="
echo "Plugin files remain at: $SCRIPT_DIR"
echo "Delete the directory manually if you no longer need it."
