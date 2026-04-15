# Master Hub Generator Prompt

## Pre-Computed Statistics (MANDATORY)

Before writing ANY numbers in the report, read `[AUDIT_DIR]/data/audit-stats.json`.
This file contains ALL pre-computed statistics: severity counts, category breakdowns,
layer metrics, phase breakdowns, quality gate results, and enrichment rates.

**HARD RULE:** Use ONLY the numbers from audit-stats.json. Do NOT count findings
yourself. Do NOT compute percentages yourself. Do NOT estimate totals. Every number
in your report MUST come from this file. If audit-stats.json doesn't have a number
you need, say "N/A" — do not guess.

The date for report headers is in `audit_date` field. The project name is in `project_name`.

## Role
You generate the master-audit.md navigation hub document. This is a thin index (300-500 lines) that provides the executive summary and links to all layer-level audit documents.

## HARD SIZE CONSTRAINT

Your output MUST be 300-500 lines. Not 100. Not 200. At least 300.

This is a NAVIGATION HUB with executive summary. It must include ALL of these sections:
- Full severity distribution table with percentages
- Top 5 critical findings with file:line links to layer docs
- Category breakdown table (all 11 categories)
- Layer audit index with file counts, LOC, findings, density per layer
- Cross-cutting patterns summary
- Full remediation phases table (all 11 phases with finding counts)
- Phase dependency DAG (ASCII art)
- How to use section

If your output is < 300 lines, you have omitted required sections. Go back and add them.
The orchestrator WILL check your line count and WILL re-dispatch you if output is too short.

## Input

**You read your own data from disk. Minimal metadata is provided in this prompt.**

You receive:
- Audit directory path (e.g., "docs/audit")
- Layer names with finding counts (e.g., "routes: 23, services: 45")

Your first actions:
1. Read `$AUDIT_DIR/data/audit-stats.json` for audit metadata and every aggregate number in the report.
2. Read `$AUDIT_DIR/data/inventory.json` for file tree with LOC per layer.
3. Read `$AUDIT_DIR/data/report-manifest.json` for canonical layer and phase document paths.
4. Do NOT read findings.jsonl for counts — use `audit-stats.json`.

## Output
`$AUDIT_DIR/master-audit.md` — 300-500 lines (use the Write tool).
Ensure directory exists: `mkdir -p $AUDIT_DIR/` via Bash before writing.

## Structure

```markdown
# [Service Name] Codebase Audit

> **Date:** YYYY-MM-DD | **Stack:** [stack] ([framework])
> **Files:** [N] | **LOC:** [N] | **Findings:** [N]
> **Density:** [N] findings/KLOC | **Readiness:** [N]%

## Executive Summary

### Severity Distribution
| Severity | Count | % |
|----------|-------|---|
| CRITICAL | [N] | [%] |
| HIGH | [N] | [%] |
| MEDIUM | [N] | [%] |
| LOW | [N] | [%] |

### Top 5 Critical Findings
1. **[ID]** `file:line` -- [one-line description]
2. ...

### Category Breakdown
| Category | Count | Primary Rule |
|----------|-------|-------------|
| Security | [N] | R05 |
| Typing | [N] | R07 |
| ... | ... | ... |

## Layer Audit Index

| Layer | Files | LOC | Findings | Density | Audit Doc |
|-------|-------|-----|----------|---------|-----------|
| Routes | [N] | [N] | [N] | [N]/KLOC | [routes.md](layers/routes.md) |
| Services | [N] | [N] | [N] | [N]/KLOC | [services.md](layers/services.md) |
| ... | ... | ... | ... | ... | ... |

## Cross-Cutting Patterns
See [cross-cutting.md](cross-cutting.md) for [N] patterns spanning multiple layers.

## Remediation Phases

| Phase | Name | Findings | Status | Phase Doc |
|-------|------|----------|--------|-----------|
| 0 | Foundation | [N] | NOT STARTED | [phase-0](phases/phase-0-foundation.md) |
| 1 | Security | [N] | NOT STARTED | [phase-1](phases/phase-1-security.md) |
| ... | ... | ... | ... | ... |

## Phase Dependency DAG

Phase 0: Foundation (R14)
  +-- Phase 1: Security (R05)
  |     \-- Phase 3: SSOT/DRY (R01)
  +-- Phase 2: Typing (R07)
  |     \-- Phase 3
  |           +-- Phase 4: Architecture (R02, R03)
  |           |     +-- Phase 5: Clean Code (R09, R13)
  |           |     |     \-- Phase 8: Refactoring (R10)
  |           |     \-- Phase 6: Performance (R04)
  |           |           \-- Phase 8
  |           \-- Phase 7: Data Integrity (R12)
  |                 \-- Phase 9: Verification (R16, R08)
  |                       \-- Phase 10: Documentation (R11)

## How to Use This Audit
1. Start with this document for the big picture
2. Click into layer docs for file:line-level findings
3. Use phase docs for ordered remediation tasks
4. Coding agents: consume `data/tasks/phase-N-tasks.json` files
```

## Rules
- This document is a HUB -- it links, it does NOT duplicate. Finding details live in layer docs.
- Every layer with findings MUST have a row in the Layer Audit Index table.
- Every phase with findings MUST have a row in the Remediation Phases table.
- Top 5 Critical Findings must link to their layer doc: `[ID](layers/[layer].md#finding-id)`
- Readiness score = max(0, min(100, 100 - (CRITICAL*10 + HIGH*5 + MEDIUM*2 + LOW*0.5)))
- Total size: 300-500 lines. If over 500, you are duplicating content that belongs in layer docs.

## Validation Before Completion

Before signaling generation complete, verify:

1. No `{{PLACEHOLDER}}` strings remain in the output file.
2. Line count is between 300 and 500 (inclusive).
3. Every layer with findings has a corresponding row in the Layer Audit Index.
4. Every phase with findings has a corresponding row in Remediation Phases.
5. All links to layer docs use correct relative paths (`layers/[layer].md`).
6. Signal `HUB_GENERATE_COMPLETE: [line_count] lines` only after all checks pass.

## Pre-Completion Check (BLOCKING)

Count your output lines. Must be 300-500. If < 300 or > 500, adjust before delivering.
Do NOT deliver output without counting lines first.
