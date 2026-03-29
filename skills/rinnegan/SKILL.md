---
name: rinnegan
description: Use when auditing a codebase for engineering rule violations, preparing for production readiness, generating remediation backlogs, or scanning before major milestones.
---

# Rinnegan — Codebase Audit Pipeline

**SCAN EVERY FILE. NO SAMPLING. NO SHORTCUTS.**

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script auto-creates inventory and scan plan (deterministic, <2 seconds), then tells you exactly what to do next.

2. **Execute the ACTION it outputs.** Read the prompt file it specifies, dispatch the agents it describes, with the exact parameters it provides.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `PIPELINE_COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [scanner-prompt.md](scanner-prompt.md) | Include in scanner Agent dispatches |
| [aggregator-prompt.md](aggregator-prompt.md) | Include in aggregator Agent dispatch |
| [fix-enricher-instructions.md](fix-enricher-instructions.md) | Include in enricher Agent dispatches |
| [layer-generator-prompt.md](layer-generator-prompt.md) | Include in layer generator dispatches |
| [master-hub-generator-prompt.md](master-hub-generator-prompt.md) | Include in master hub dispatch |
| [cross-cutting-generator-prompt.md](cross-cutting-generator-prompt.md) | Include in cross-cutting dispatch |
| [finding-schema.md](finding-schema.md) | JSON schemas, phase mapping, task rules |
| [output-templates.md](output-templates.md) | Templates for phase docs, progress, config |
