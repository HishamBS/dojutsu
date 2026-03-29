#!/usr/bin/env bash
set -euo pipefail

SRC="${HOME}/dotfiles/spsm/.config/spsm/skills"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills"

echo "=== Syncing from dotfiles SSOT ==="

for skill in rinnegan rasengan sharingan byakugan dojutsu; do
    if [ ! -d "$SRC/$skill" ]; then
        echo "SKIP: $skill (not found in dotfiles)"
        continue
    fi
    rm -rf "$DEST/$skill"
    cp -R "$SRC/$skill" "$DEST/$skill"
    # Remove non-distributable artifacts
    find "$DEST/$skill" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null
    find "$DEST/$skill" -name '.pytest_cache' -type d -exec rm -rf {} + 2>/dev/null
    rm -rf "$DEST/$skill/.coverage" "$DEST/$skill/audits" "$DEST/$skill/docs/plans"
    echo "  Synced: $skill"
done

echo "=== Done ==="
