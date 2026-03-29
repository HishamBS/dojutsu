# Naruto Trio

Codebase audit, autonomous remediation, and evidence-based QA pipeline for Claude Code.

Three skills that work together as a pipeline:

1. **Rinnegan** (`/rinnegan`) -- Audits a codebase against 20 engineering rules. Produces a structured audit with findings, phase-ordered remediation backlog, and documentation.

2. **Rasengan** (`/rasengan`) -- Autonomously fixes audit findings phase by phase. Reads rinnegan's output, applies fixes with build verification after each edit, and commits per phase.

3. **Sharingan** (`/sharingan`) -- Evidence-based QA pipeline with 5 verification gates: deterministic build, spec compliance, code correctness, independent verification, and runtime checks.

## Prerequisites

- macOS (tested on macOS 14+)
- Python 3.9+
- Claude Code CLI

## Install

```bash
git clone https://github.com/HishamBS/naruto-trio.git ~/naruto-trio
bash ~/naruto-trio/setup.sh
```

Restart Claude Code after installation.

## Usage

### Audit a codebase

```
cd your-project
/rinnegan
```

Rinnegan runs autonomously. It creates `docs/audit/` with findings, layer documentation, and a phase-ordered remediation backlog.

### Fix audit findings

```
/rasengan
```

Rasengan reads the audit output and fixes findings phase by phase. It verifies the build after each fix and commits after each phase.

### Verify changes

```
/sharingan
```

Sharingan runs 5 verification gates and produces a CLEAR or BLOCKED verdict.

### Full pipeline

Run them in sequence: `/rinnegan` then `/rasengan` then `/sharingan`.

## Uninstall

```bash
bash ~/naruto-trio/uninstall.sh
```

## How It Works

Each skill uses a **state machine pipeline** driven by a Python script. When you invoke `/rinnegan`, Claude Code reads the SKILL.md which instructs it to:

1. Run the pipeline script
2. Execute the ACTION it outputs
3. Run the script again
4. Repeat until complete

The pipeline script checks disk state and determines the next action. Claude Code provides the intelligence (reading files, applying fixes, generating documentation). The script provides the routing (what to do next, in what order).

## Test Suite

```bash
cd ~/naruto-trio
python3 -m pytest tests/ -v
```

93 tests (30 rasengan + 63 rinnegan).
