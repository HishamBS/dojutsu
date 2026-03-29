# Dojutsu

Codebase audit, deep analysis, autonomous remediation, and evidence-based QA pipeline for Claude Code.

Five skills that chain into one automated pipeline:

1. **Rinnegan** (`/rinnegan`) -- Audits a codebase against 20 engineering rules. Produces structured findings, phase-ordered remediation backlog, and layer documentation.

2. **Byakugan** (`/byakugan`) -- Deep analysis: builds dependency graph, clusters related findings, traces blast radius, produces executive narrative, compliance scorecard, and deployment plan.

3. **Rasengan** (`/rasengan`) -- Autonomously fixes audit findings phase by phase. Build verification after each fix. Commits per phase.

4. **Sharingan** (`/sharingan`) -- Evidence-based QA with 5 verification gates. Runs after each rasengan phase to catch regressions early.

5. **Dojutsu** (`/dojutsu`) -- Orchestrator that chains all 4 eyes. One command, fully automated, session-resilient.

## Prerequisites

- bash (tested on macOS 14+)
- Python 3.9+
- Claude Code CLI (or any coding agent that runs Python and bash)

## Install

```bash
git clone https://github.com/HishamBS/dojutsu.git ~/dojutsu
bash ~/dojutsu/setup.sh
```

Restart Claude Code after installation.

## Usage

### Full pipeline (recommended)

```
cd your-project
/dojutsu
```

One command. The orchestrator drives all 4 eyes autonomously:

```
rinnegan (detect) -> byakugan (analyze) -> [rasengan phase N -> sharingan phase N] x phases -> COMPLETE
```

Survives session changes. Resume by running `/dojutsu` again.

### Individual skills

Each eye can also be invoked standalone:

```
/rinnegan    # Audit only
/byakugan    # Deep analysis (requires rinnegan output)
/rasengan    # Fix findings (requires rinnegan output)
/sharingan   # Verify changes
```

## Uninstall

```bash
bash ~/dojutsu/uninstall.sh
```

## How It Works

Each skill uses a **state machine pipeline** driven by a Python script. The script checks disk state and outputs one ACTION for the agent to execute. The agent executes it, runs the script again, and repeats until complete.

The dojutsu orchestrator delegates to each eye's script in sequence, passing through the eye's ACTION verbatim. State is HMAC-signed on disk, so the pipeline survives session compaction, agent switches, and context exhaustion.

## Test Suite

```bash
cd ~/dojutsu
bash run-tests.sh
```

93 tests (30 rasengan + 63 rinnegan).
