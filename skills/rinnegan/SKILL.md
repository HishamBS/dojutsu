---
name: rinnegan
description: Use when auditing a codebase for engineering rule violations,
  preparing for production readiness, generating remediation backlogs, or
  scanning before major milestones.
---

# Rinnegan — Codebase Audit Pipeline

## How It Works

1. **Run the pipeline script.** Run: `bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR`
   The script auto-creates inventory and scan plan (deterministic, <2 seconds), then tells you exactly what to do next.

2. **Execute the ACTION it outputs.** Scanner and enricher stages still dispatch agents. Aggregation of scanner output runs in code (`scripts/aggregate_findings.ts`: dedupe, layers, IDs), and final published audit docs are compiled deterministically from SSOT data files; do not hand-author or repair them manually.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `PIPELINE_COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [scanner-prompt.md](scanner-prompt.md) | Include in scanner Agent dispatches |
| [fix-enricher-instructions.md](fix-enricher-instructions.md) | Include in enricher Agent dispatches |
| [finding-schema.md](finding-schema.md) | JSON schemas, phase mapping, task rules |
| [output-templates.md](output-templates.md) | Data contracts for rasengan-config/state; doc layouts are rendered by `scripts/bundle_renderer.ts` |

## Publication Contract

- `data/findings.jsonl` is the finding SSOT.
- `data/audit-stats.json` is the aggregate-metrics SSOT.
- `data/quality-gate.json` is the gate-verdict SSOT.
- `master-audit.md`, `layers/*.md`, `cross-cutting.md`, `progress.md`, and `agent-instructions.md` are compiled deterministically from those sources.
- If the rendered docs are wrong, fix the SSOT data or renderer. Do not patch the markdown by hand.

## Configuration

- **Meta-file allowlist:** a file is exempt only when directory, filename, and first-100-line content-marker checks all match. Filename resemblance alone never exempts production code.
- **LOC pre-filter:** files below 10 lines are tagged `nominal: true` and skipped by the semantic scanner while deterministic grep still scans them. Put newline-separated path prefixes in `<project>/.rinnegan/authority-paths.txt` to keep authority files in scope.
- **`--audit-only`:** skips enrichment and persists across pipeline re-entry through `data/.audit-only`. The marker also skips the null-fix gate (unenriched findings carry no fix), so repeated runs go on to the phase task files, the report bundle and `PIPELINE_COMPLETE`; a run without the marker keeps the gate.
