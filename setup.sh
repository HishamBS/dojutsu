#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${HOME}/.coding-agent/skills"
SHARINGAN_LINK="${HOME}/.config/spsm/sharingan"
SETTINGS="${HOME}/.claude/settings.json"

echo "=== Naruto Trio Installer ==="
echo ""

# 1. Check Python 3.9+
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install with: brew install python@3.12"
    exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
    echo "ERROR: Python 3.9+ required, found $PY_VERSION"
    exit 1
fi
echo "Python $PY_VERSION detected"

# 2. Install skills
mkdir -p "$SKILLS_DIR"

for skill in rinnegan rasengan sharingan; do
    target="$SKILLS_DIR/$skill"
    if [ -L "$target" ]; then
        rm "$target"
    elif [ -d "$target" ]; then
        echo "WARNING: $target exists (backing up to ${target}.bak)"
        mv "$target" "${target}.bak"
    fi
    ln -s "$SCRIPT_DIR/skills/$skill" "$target"
    echo "Installed /$(basename "$target")"
done

# 3. Set up sharingan core symlink
mkdir -p "$(dirname "$SHARINGAN_LINK")"
if [ -L "$SHARINGAN_LINK" ]; then
    rm "$SHARINGAN_LINK"
fi
ln -s "$SCRIPT_DIR/skills/sharingan/core" "$SHARINGAN_LINK"
echo "Linked sharingan core to $SHARINGAN_LINK"

# 4. Create stub policy if missing
POLICY_DIR="${HOME}/.config/spsm/policy"
if [ ! -d "$POLICY_DIR" ]; then
    mkdir -p "$POLICY_DIR"
    cat > "$POLICY_DIR/agent-capabilities.yaml" <<'YAML'
# Default agent capabilities for sharingan verification
agents:
  default:
    max_parallel: 5
    timeout_seconds: 300
YAML
    echo "Created default policy at $POLICY_DIR"
fi

# 5. Make all shell scripts executable
find "$SCRIPT_DIR/skills" -name "*.sh" -exec chmod +x {} \;
echo "Shell scripts marked executable"

# 6. Run tests
echo ""
echo "Running test suite..."
if python3 -m pytest "$SCRIPT_DIR/tests/" -q 2>/dev/null; then
    echo "All tests passed"
else
    echo "WARNING: Some tests failed. Skills are installed but may have issues."
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Available commands:"
echo "  /rinnegan   - Audit a codebase for engineering rule violations"
echo "  /rasengan   - Autonomously fix audit findings phase by phase"
echo "  /sharingan  - Evidence-based QA pipeline (5 verification gates)"
echo ""
echo "Run /rinnegan in any project to start your first audit."
