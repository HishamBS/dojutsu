---
name: dojutsu
description: Full automated pipeline — audit, analyze, fix, verify. Session-resilient, agent-agnostic. Run on any project for complete quality remediation.
---

# Dojutsu — Unified Codebase Quality Pipeline

## Quick Start

```bash
# Audit only (DEFAULT — safe, no code changes):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR

# Audit + fix (interactive — approve after each phase):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix

# Fix specific phases only:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix --phases 0,1,2

# Fully autonomous (no approval gates):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix --auto

# Resume from saved state:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --resume

# Show current state:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --status

# Remove all audit data:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --clean
```

## Flags

| Flag | Requires | Description |
|------|----------|-------------|
| *(none)* | | Audit only. Stops after byakugan. No code changes. |
| `--fix` | | Enable code fixing (rasengan + sharingan). |
| `--phases N,M` | `--fix` | Fix only selected phases. |
| `--interactive` | `--fix` | Approve after each phase. Default with --fix. |
| `--auto` | `--fix` | No approval gates. Fully autonomous. |
| `--resume` | | Resume from saved state and flags. |
| `--status` | | Show state without advancing pipeline. |
| `--clean` | | Remove docs/audit/ for fresh start. |

## How It Works

1. Run the pipeline script with flags.
2. Execute the ACTION it outputs.
3. Run the script again. Repeat until complete.

## Pipeline

```
AUDIT (default):  rinnegan → byakugan → AUDIT_COMPLETE
FIX (--fix):      rinnegan → byakugan → [rasengan N → sharingan N] × phases → COMPLETE
```

## Resume Rules

1. ALWAYS run the pipeline script first.
2. NEVER write inline scripts to generate artifacts.
3. NEVER continue from memory of a previous session.
4. The pipeline script is the ONLY authority.
