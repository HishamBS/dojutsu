---
name: rinnegan
description: Use when auditing a codebase for engineering rule violations, preparing for production readiness, generating remediation backlogs, or scanning before major milestones.
---

# Rinnegan — Codebase Audit Pipeline

**SCAN EVERY FILE. NO SAMPLING. NO SHORTCUTS.**

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script auto-creates inventory and scan plan (deterministic, <2 seconds), then tells you exactly what to do next.

2. **Execute the ACTION it outputs.** Scanner and enricher stages still dispatch agents. Final published audit docs are compiled deterministically from SSOT data files; do not hand-author or repair them manually.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `PIPELINE_COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [scanner-prompt.md](scanner-prompt.md) | Include in scanner Agent dispatches |
| [aggregator-prompt.md](aggregator-prompt.md) | Include in aggregator Agent dispatch |
| [fix-enricher-instructions.md](fix-enricher-instructions.md) | Include in enricher Agent dispatches |
| [finding-schema.md](finding-schema.md) | JSON schemas, phase mapping, task rules |
| [output-templates.md](output-templates.md) | Templates for phase docs, progress, config |

## Publication Contract

- `data/findings.jsonl` is the finding SSOT.
- `data/audit-stats.json` is the aggregate-metrics SSOT.
- `data/quality-gate.json` is the gate-verdict SSOT.
- `master-audit.md`, `layers/*.md`, `cross-cutting.md`, `progress.md`, and `agent-instructions.md` are compiled deterministically from those sources.
- If the rendered docs are wrong, fix the SSOT data or renderer. Do not patch the markdown by hand.
