---
name: dojutsu
description: Full automated pipeline — audit, analyze, fix, verify. Session-resilient, agent-agnostic. Run on any project for complete quality remediation.
---

# Dojutsu — Unified Codebase Quality Pipeline

Four eyes, one command. Fully automated. Survives session changes. Works with any coding agent.

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script detects which eye is needed and delegates to it.

2. **Execute the ACTION it outputs.** The action comes from whichever eye is currently active (rinnegan, byakugan, rasengan, or sharingan).

3. **Run the script again.** Repeat until `PIPELINE_COMPLETE`.

## Pipeline Sequence

```
rinnegan (detect) → byakugan (analyze) → [rasengan phase N → sharingan phase N] × phases → COMPLETE
```

Each phase is fixed by rasengan, then fully verified by sharingan (all 5 gates) before advancing.

## Session Resilience

- All state lives on disk (`docs/audit/data/dojutsu-state.json`)
- Pipeline auto-pauses when token budget is reached (tracks actual usage per dispatch)
- If your session ends mid-pipeline: start a new session, run the script — it resumes exactly where you left off
- Works with Claude Code, Codex, or any agent that can run Python and bash

## CRITICAL: Resume Rules

When resuming a paused pipeline (new session, rate limit reset, or any restart):

1. **ALWAYS run the pipeline script first.** It reads disk state and knows exactly what to do.
2. **NEVER write inline Python/bash scripts** to generate pipeline artifacts (findings, docs, task files, audit reports).
3. **NEVER continue from memory** of what happened in a previous session. Your memory may be stale or wrong.
4. **The pipeline script is the ONLY authority** on what needs to happen next.

If you feel tempted to "just quickly generate" a missing file — STOP. Run the pipeline script instead.
