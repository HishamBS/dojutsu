---
name: byakugan
description: Deep codebase analysis — dependency tracing, blast radius, impact narratives, compliance scorecards. Run after rinnegan to get v5-quality audit depth.
---

# Byakugan — Deep Codebase Analysis

The eye that sees connections. Traces dependencies, analyzes blast radius, and produces structured impact analysis that the pipeline compiles into the final deep-analysis bundle.

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script auto-builds the dependency graph and clusters findings (deterministic, <10 seconds), then tells you what to do next.

2. **Execute the ACTION it outputs.** Dispatch only the impact analysis agents the pipeline requests. Final published deep-analysis docs are rendered deterministically from SSOT inputs and validated before completion.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [impact-analysis-prompt.md](impact-analysis-prompt.md) | Include in impact analysis Agent dispatches |

## Publication Contract

- `deep/clusters.json` is the cluster-taxonomy SSOT.
- `deep/impact-analysis.jsonl` is the structured impact SSOT.
- `deep/narrative.md`, `deep/scorecard.md`, `deep/deployment-plan.md`, and `deep/executive-brief.md` are compiled deterministically from SSOT data.
- If a published deep doc is contradictory, fix the source data or renderer. Do not hand-edit the markdown.
