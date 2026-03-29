#!/usr/bin/env bash
# Sharingan enforcement hook — delegates to agent-agnostic enforce.sh
# This thin wrapper ensures the Claude Code stop hook calls the shared enforcement script.

exec ~/.config/spsm/sharingan/enforce.sh "$@"
