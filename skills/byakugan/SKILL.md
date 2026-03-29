---
name: byakugan
description: Deep codebase analysis — dependency tracing, blast radius, impact narratives, compliance scorecards. Run after rinnegan to get v5-quality audit depth.
---

# Byakugan — Deep Codebase Analysis

The eye that sees connections. Traces dependencies, analyzes blast radius, produces executive-quality audit narratives.

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script auto-builds the dependency graph and clusters findings (deterministic, <10 seconds), then tells you what to do next.

2. **Execute the ACTION it outputs.** Dispatch impact analysis agents, narrative generators, scorecard generators as instructed.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [impact-analysis-prompt.md](impact-analysis-prompt.md) | Include in impact analysis Agent dispatches |
| [narrative-generator-prompt.md](narrative-generator-prompt.md) | Include in narrative generator dispatch |
| [scorecard-generator-prompt.md](scorecard-generator-prompt.md) | Include in scorecard generator dispatch |
| [deployment-plan-prompt.md](deployment-plan-prompt.md) | Include in deployment plan dispatch |
