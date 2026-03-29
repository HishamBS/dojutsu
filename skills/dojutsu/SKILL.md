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
- If your session ends mid-pipeline: start a new session, run the script — it resumes exactly where you left off
- Works with Claude Code, Codex, or any agent that can run Python and bash
- Progress narrative (`docs/audit/data/dojutsu-progress.jsonl`) provides context for new sessions
- HMAC-signed state prevents tampering
- Git checkpoints at every stage transition enable rollback
