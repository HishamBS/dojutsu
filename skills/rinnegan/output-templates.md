# Output Templates

Exact structure for every deliverable rinnegan generates. All placeholders use `{{PLACEHOLDER}}` syntax. Generators MUST follow these structures — do not invent new sections or reorder.

---

## Output Size Requirements (Non-Negotiable)

| Deliverable | Minimum Size |
|-------------|-------------|
| master-audit.md | 300-500 lines (navigation hub only) |
| Sum of all layers/*.md | >= 20 lines per KLOC |
| cross-cutting.md | >= 50 lines per cross-cutting group |
| Phase files collectively | >= 10 lines per finding |

**Layer docs are the primary source of finding detail. master-audit.md links to them but does NOT duplicate findings.**

Examples:
- A 20K LOC codebase -> sum of all layer docs >= 400 lines
- An 80K LOC codebase -> sum of all layer docs >= 1,600 lines
- master-audit.md is always 300-500 lines regardless of codebase size

Output below these thresholds = generation INCOMPLETE. The layer generators must continue writing until the minimum is met.

---

## 1. master-audit.md (Navigation Hub)

master-audit.md is a thin navigation hub (300-500 lines). Finding details live in layer docs under `layers/`. This document links to them but does NOT duplicate finding detail.

```markdown
# {{SERVICE_NAME}} Codebase Audit

> **Date:** {{DATE}} | **Stack:** {{STACK}} ({{FRAMEWORK}})
> **Files:** {{TOTAL_FILES}} | **LOC:** {{TOTAL_LOC}} | **Findings:** {{TOTAL_FINDINGS}}
> **Density:** {{FINDINGS_PER_KLOC}} findings/KLOC | **Readiness:** {{READINESS_PCT}}%

## Executive Summary

### Severity Distribution

| Severity | Count | % |
|----------|-------|---|
| CRITICAL | {{CRITICAL_COUNT}} | {{CRITICAL_PCT}}% |
| HIGH | {{HIGH_COUNT}} | {{HIGH_PCT}}% |
| MEDIUM | {{MEDIUM_COUNT}} | {{MEDIUM_PCT}}% |
| LOW | {{LOW_COUNT}} | {{LOW_PCT}}% |

### Top 5 Critical Findings

1. **[{{ID_1}}](layers/{{LAYER_1}}-audit.md#{{ID_1_ANCHOR}})** `{{FILE_1}}:{{LINE_1}}` -- {{DESC_1}}
2. **[{{ID_2}}](layers/{{LAYER_2}}-audit.md#{{ID_2_ANCHOR}})** `{{FILE_2}}:{{LINE_2}}` -- {{DESC_2}}
3. ...

### Category Breakdown

| Category | Count | Primary Rule |
|----------|-------|-------------|
| Security | {{SEC_COUNT}} | R05 |
| Typing | {{TYP_COUNT}} | R07 |
| SSOT/DRY | {{DRY_COUNT}} | R01 |
| Architecture | {{ARC_COUNT}} | R02, R03 |
| Clean Code | {{CLN_COUNT}} | R09, R13 |
| Performance | {{PRF_COUNT}} | R04 |
| Data Integrity | {{DAT_COUNT}} | R12 |
| Refactoring | {{REF_COUNT}} | R10 |
| Full Stack | {{STK_COUNT}} | R16, R08 |
| Documentation | {{DOC_COUNT}} | R11 |
| Build | {{BLD_COUNT}} | R14 |

## Layer Audit Index

| Layer | Files | LOC | Findings | Density | Audit Doc |
|-------|-------|-----|----------|---------|-----------|
| {{LAYER_NAME}} | {{FILES}} | {{LOC}} | {{FINDINGS}} | {{DENSITY}}/KLOC | [{{LAYER_NAME}}-audit.md](layers/{{LAYER_NAME}}-audit.md) |
| ... | ... | ... | ... | ... | ... |

## Cross-Cutting Patterns

See [cross-cutting.md](cross-cutting.md) for {{CROSS_CUTTING_COUNT}} patterns spanning multiple layers.

## Remediation Phases

| Phase | Name | Findings | Status | Phase Doc |
|-------|------|----------|--------|-----------|
| 0 | Foundation | {{P0_COUNT}} | NOT STARTED | [phase-0](phases/phase-0-foundation.md) |
| 1 | Security | {{P1_COUNT}} | NOT STARTED | [phase-1](phases/phase-1-security.md) |
| 2 | Typing | {{P2_COUNT}} | NOT STARTED | [phase-2](phases/phase-2-typing.md) |
| 3 | SSOT/DRY | {{P3_COUNT}} | NOT STARTED | [phase-3](phases/phase-3-ssot-dry.md) |
| 4 | Architecture | {{P4_COUNT}} | NOT STARTED | [phase-4](phases/phase-4-architecture.md) |
| 5 | Clean Code | {{P5_COUNT}} | NOT STARTED | [phase-5](phases/phase-5-clean-code.md) |
| 6 | Performance | {{P6_COUNT}} | NOT STARTED | [phase-6](phases/phase-6-performance.md) |
| 7 | Data Integrity | {{P7_COUNT}} | NOT STARTED | [phase-7](phases/phase-7-data-integrity.md) |
| 8 | Refactoring | {{P8_COUNT}} | NOT STARTED | [phase-8](phases/phase-8-refactoring.md) |
| 9 | Verification | {{P9_COUNT}} | NOT STARTED | [phase-9](phases/phase-9-verification.md) |
| 10 | Documentation | {{P10_COUNT}} | NOT STARTED | [phase-10](phases/phase-10-documentation.md) |

## Phase Dependency DAG

Phase 0: Foundation (R14) .............. {{P0_COUNT}} findings
  +-- Phase 1: Security (R05) ......... {{P1_COUNT}} findings
  |     \-- Phase 3: SSOT/DRY (R01) .. {{P3_COUNT}} findings
  +-- Phase 2: Typing (R07) ........... {{P2_COUNT}} findings
  |     \-- Phase 3
  |           +-- Phase 4: Architecture (R02, R03) .. {{P4_COUNT}} findings
  |           |     +-- Phase 5: Clean Code (R09, R13) .. {{P5_COUNT}} findings
  |           |     |     \-- Phase 8: Refactoring (R10) .. {{P8_COUNT}} findings
  |           |     \-- Phase 6: Performance (R04) .. {{P6_COUNT}} findings
  |           |           \-- Phase 8
  |           \-- Phase 7: Data Integrity (R12) .. {{P7_COUNT}} findings
  |                 \-- Phase 9: Verification (R16, R08) .. {{P9_COUNT}} findings
  |                       \-- Phase 10: Documentation (R11) .. {{P10_COUNT}} findings

## How to Use This Audit

1. Start with this document for the big picture
2. Click into layer docs for file:line-level findings
3. Use phase docs for ordered remediation tasks
4. Coding agents: consume `data/tasks/phase-N-tasks.json` files
```

---

## 1b. layers/[layer]-audit.md (Per-Layer Deep Dive)

One file per architectural layer, generated in parallel. Each layer doc contains ALL finding details for that layer.

```markdown
# {{LAYER_NAME}} Layer Audit

> **Service:** {{SERVICE_NAME}} | **Layer:** {{LAYER_NAME}}
> **Files:** {{LAYER_FILE_COUNT}} | **LOC:** {{LAYER_LOC}} | **Findings:** {{LAYER_FINDING_COUNT}}
> **Density:** {{LAYER_DENSITY}} findings/KLOC

## Layer Overview
{{LAYER_PURPOSE_DESCRIPTION}}

## Findings

### {{FILE_GROUP_OR_RULE_GROUP}}

| ID | Line | Severity | Rule | Finding |
|----|------|----------|------|---------|
| {{FINDING_ID}} | {{LINE}} | {{SEVERITY}} | {{RULE}} | {{DESCRIPTION}} |
| ... | ... | ... | ... | ... |

#### {{FINDING_ID}}: {{TITLE}}
**File:** `{{FILE}}:{{LINE}}`
**Severity:** {{SEVERITY}} | **Rule:** {{RULE}} | **Effort:** {{EFFORT}}

**Current code:**
```{{LANG}}
{{CURRENT_CODE}}
```

**Why this is a problem:**
{{JUNIOR_FRIENDLY_EXPLANATION}}

**Target code:**
```{{LANG}}
{{TARGET_CODE}}
```

[Repeat for EVERY finding in this layer]

## Layer Statistics
- Functions >30 lines: {{COUNT}} ({{FILE_LINE_LIST}})
- Exception handling blocks: {{COUNT}}
- Typing coverage: {{PCT}}% of functions with full annotations

## Verification Commands
```bash
{{LAYER_SPECIFIC_GREP_COMMANDS}}
```
```

**Per-layer minimum:** >= 20 * (layer_loc / 1000) lines. If shorter, you have not provided enough detail per finding.

---

## 1c. cross-cutting.md

Covers violation patterns spanning multiple layers.

```markdown
# Cross-Cutting Patterns

## Pattern: {{GROUP_NAME}}
**Rule:** {{RULE}} | **Instances:** {{INSTANCE_COUNT}} across {{LAYER_COUNT}} layers | **Severity:** {{HIGHEST_SEVERITY}}

**What it is:** {{PATTERN_DESCRIPTION}}

**Why it matters:** {{JUNIOR_FRIENDLY_EXPLANATION}}

**Occurrences:**
| # | File | Line | Layer | Snippet |
|---|------|------|-------|---------|
| 1 | {{FILE}} | {{LINE}} | {{LAYER}} | `{{SNIPPET}}` |
| ... | ... | ... | ... | ... |

**Recommended fix:** {{FIX_DESCRIPTION}}

**Verification:**
```bash
{{GREP_COMMAND}}  # Expected: 0
```

[Repeat for every cross-cutting group]
```

**Minimum:** >= 50 lines per cross-cutting group.

---

## 1d. Output Directory Structure

```
docs/audit/
  master-audit.md              # Navigation hub: exec summary, severity heatmap, layer links
  layers/                      # Per-layer deep-dives (parallel-generated)
    routes-audit.md            # All findings for routes layer
    services-audit.md          # All findings for services layer
    components-audit.md        # etc.
    hooks-audit.md
    types-audit.md
    stores-audit.md
    config-audit.md
    infrastructure-audit.md
    ...                        # One per layer from inventory
  cross-cutting.md             # Patterns spanning multiple layers
  progress.md                  # Phase tracker
  agent-instructions.md        # How agents consume JSON (ALWAYS generated)
  phases/                      # Checkable task lists per phase
    phase-0-foundation.md
    phase-1-security.md
    ...phase-10-documentation.md
  data/                        # Machine-readable JSON
    findings.jsonl
    inventory.json
    phase-dag.json
    config.json
  data/tasks/                  # Per-phase task arrays
    phase-0-tasks.json
    phase-1-tasks.json
    ...phase-10-tasks.json
  data/rasengan-config.json    # Rasengan execution config (created by rinnegan)
  data/rasengan-state.json     # Rasengan session state (created by rasengan at runtime)
```

---

## 2. Phase File (phases/phase-N-*.md)

One file per phase. File naming: `phase-0-foundation.md`, `phase-1-security.md`, etc.

```markdown
# Phase {{N}}: {{PHASE_NAME}} ({{RULES_CSV}})

> **Prerequisites:** {{PREREQUISITE_PHASES}} (or "None" for Phase 0)
> **Findings:** {{FINDING_COUNT}} | **Effort:** {{EFFORT_SUMMARY}} | **Files touched:** {{FILE_COUNT}}

## Why This Phase Matters

{{JUNIOR_FRIENDLY_EXPLANATION}}

This explanation must be 2-3 sentences. It must explain what the rule prevents, what goes wrong without it, and why it blocks later phases. Written for an engineer with 0-2 years of experience.

---

## Tasks

### {{N}}.1 {{TASK_GROUP_NAME}}

**Why:** {{JUNIOR_FRIENDLY_GROUP_EXPLANATION}}

This explains the specific pattern being fixed within this group. 1-2 sentences describing the problem and its consequences in concrete terms.

- [ ] `{{FILE_PATH}}:{{LINE}}`
  **Current:** `{{ACTUAL_CODE_ON_THAT_LINE}}`
  **Target:** `{{CORRECTED_CODE}}`
  **Import:** `{{NEW_IMPORT_STATEMENT}}` (omit this line if no import needed)

- [ ] `{{FILE_PATH}}:{{LINE}}`
  **Current:** `{{ACTUAL_CODE_ON_THAT_LINE}}`
  **Target:** `{{CORRECTED_CODE}}`

### {{N}}.2 {{TASK_GROUP_NAME}}

**Why:** {{JUNIOR_FRIENDLY_GROUP_EXPLANATION}}

- [ ] `{{FILE_PATH}}:{{LINE}}`
  **Current:** `{{ACTUAL_CODE_ON_THAT_LINE}}`
  **Target:** `{{CORRECTED_CODE}}`

(Continue for all task groups in this phase. Group tasks by pattern similarity, not by file. Each group contains tasks that share the same fix pattern.)

---

## New Files

If this phase requires creating new files, list them here with complete contents.

### `{{NEW_FILE_PATH}}`

**Resolves:** {{FINDING_IDS_CSV}}

```{{LANG}}
{{COMPLETE_FILE_CONTENTS}}
```

---

## Verification

```bash
{{VERIFICATION_COMMAND}}  # Expected: {{EXPECTED_OUTPUT}}
```

Run this command from the project root after completing all tasks in this phase. If the output does not match the expected value, one or more tasks were missed or applied incorrectly.
```

### Task Group Ordering Rules

1. Within a phase, groups are ordered by severity (CRITICAL groups first).
2. Within a group, tasks are ordered by file path (alphabetical) then line number (ascending).
3. Groups are numbered `{{PHASE}}.1`, `{{PHASE}}.2`, etc.
4. A group should contain 3-15 tasks. If a pattern has >15 instances, split into sub-groups by layer.
5. **Task count consistency:** Total tasks across all groups in a phase MUST equal the finding count for that phase in master-audit. Discrepancy = generation bug.

---

## 3. progress.md

```markdown
# Audit Remediation Progress

> **Generated:** {{DATE}} | **Service:** {{SERVICE_NAME}} | **Total Findings:** {{TOTAL_FINDINGS}}

## Phase Status

| Phase | Name | Rule(s) | Findings | Completed | Blocked By | Status |
|-------|------|---------|----------|-----------|------------|--------|
| 0 | Foundation | R14 | {{P0_COUNT}} | 0 | -- | NOT STARTED |
| 1 | Security | R05 | {{P1_COUNT}} | 0 | Phase 0 | BLOCKED |
| 2 | Typing | R07 | {{P2_COUNT}} | 0 | Phase 0 | BLOCKED |
| 3 | SSOT/DRY | R01 | {{P3_COUNT}} | 0 | Phases 1, 2 | BLOCKED |
| 4 | Architecture | R02, R03 | {{P4_COUNT}} | 0 | Phase 3 | BLOCKED |
| 5 | Clean Code | R09, R13 | {{P5_COUNT}} | 0 | Phase 4 | BLOCKED |
| 6 | Performance | R04 | {{P6_COUNT}} | 0 | Phase 4 | BLOCKED |
| 7 | Data Integrity | R12 | {{P7_COUNT}} | 0 | Phase 3 | BLOCKED |
| 8 | Refactoring | R10 | {{P8_COUNT}} | 0 | Phases 5, 6 | BLOCKED |
| 9 | Verification | R16, R08 | {{P9_COUNT}} | 0 | Phases 7, 8 | BLOCKED |
| 10 | Documentation | R11 | {{P10_COUNT}} | 0 | Phase 9 | BLOCKED |

## Severity Burndown

| Severity | Total | Resolved | Remaining |
|----------|-------|----------|-----------|
| CRITICAL | {{CRITICAL_COUNT}} | 0 | {{CRITICAL_COUNT}} |
| HIGH | {{HIGH_COUNT}} | 0 | {{HIGH_COUNT}} |
| MEDIUM | {{MEDIUM_COUNT}} | 0 | {{MEDIUM_COUNT}} |
| LOW | {{LOW_COUNT}} | 0 | {{LOW_COUNT}} |

## How to Update

1. Complete all tasks in a phase file (`phases/phase-N-*.md`)
2. Check off each task as you complete it (change `- [ ]` to `- [x]`)
3. Run the verification command at the bottom of the phase file
4. Update the corresponding row in the Phase Status table above:
   - Set `Completed` to the number of resolved findings
   - Set `Status` to `COMPLETE` when all findings are resolved and verification passes
5. Update the Severity Burndown table with new resolved counts
6. Check if downstream phases are now unblocked:
   - A phase becomes `NOT STARTED` when ALL its prerequisites are `COMPLETE`
   - A phase stays `BLOCKED` until every prerequisite is `COMPLETE`
7. Move to the next unblocked phase

## Change Log

| Date | Phase | Action | Findings Resolved |
|------|-------|--------|-------------------|
| {{DATE}} | -- | Audit generated | 0 |
```

---

## 4. agent-instructions.md

```markdown
# Agent Instructions: Consuming the Audit

This document explains how coding agents (Claude Code, Codex, Cursor, etc.) should consume and execute the structured audit output.

## Directory Layout

```
docs/audit/
  master-audit.md            -- Full human-readable audit (reference only)
  progress.md                -- Track completion across phases
  agent-instructions.md      -- This file
  phases/                    -- Human-readable phase task lists
    phase-0-foundation.md
    phase-1-security.md
    ...
  data/                      -- Machine-readable structured data
    findings.jsonl           -- All findings as JSONL
    inventory.json           -- File tree with LOC counts
    phase-dag.json           -- Phase dependency graph
    config.json              -- Audit metadata
  data/tasks/                -- Per-phase task arrays (primary agent input)
    phase-0-tasks.json
    phase-1-tasks.json
    ...
```

## Execution Protocol

### Step 1: Determine Current Phase

Read `data/phase-dag.json` and `progress.md` to find the lowest-numbered phase with status `NOT STARTED`. Phases with status `BLOCKED` cannot be started until their prerequisites are `COMPLETE`.

### Step 2: Load Phase Tasks

Read the JSON task file for the current phase:
```
data/tasks/phase-{{N}}-tasks.json
```

Parse the `tasks` array. Each task object contains all information needed to apply the fix.

### Step 3: Execute Each Task

For each task in the `tasks` array (process in order):

1. **Read the file** at `task.file`, focusing on `task.line`
2. **Verify the current code** matches `task.current_code`
   - If it matches: apply `task.target_code` as the replacement
   - If it does NOT match: the code has changed since the audit. Set `task.status` to `"blocked"` and add a `"blocked_reason"` field explaining the mismatch. Flag for human review. Do NOT guess.
3. **Add imports** listed in `task.imports_needed` (if present) at the top of the file, respecting existing import order
4. **Update task status** in the JSON file: set `task.status` to `"completed"`
5. **Increment** the `completed` count in the phase object

### Step 4: Run Verification

After all tasks in the phase are complete (or blocked):

1. Run the command in `verification.command`
2. Compare output to `verification.expected`
3. If verification passes: set `phase.status` to `"complete"` in the JSON
4. If verification fails: review blocked/skipped tasks — they likely explain the gap

### Step 5: Update Progress

1. Update `progress.md` with the new phase status
2. Check if downstream phases are now unblocked
3. Return to Step 1 for the next phase

## Rules for Agents

1. **Work one phase at a time.** Never skip ahead. The DAG exists for a reason: later fixes depend on earlier ones being stable.

2. **Read before writing.** Always Read the target file and verify the line content matches `current_code` before applying any change. Stale line numbers are the most common failure mode.

3. **Do not invent fixes.** If `target_code` is provided, use it exactly. If `target_code` is null, the finding requires human judgment — set status to `"blocked"` and move on.

4. **Preserve surrounding code.** Replace only the lines indicated. Do not reformat, reorder imports globally, or "clean up" nearby code. That work belongs to its own finding in a later phase.

5. **Commit per phase.** After completing a phase, commit all changes with a message like: `fix(phase-N): [phase name] remediation`. This makes rollback granular.

6. **Run verification before moving on.** The verification command is the source of truth for phase completion, not the task checklist.

7. **Flag mismatches, never force.** If the code at a given line does not match `current_code`, the file was modified after the audit. Do not attempt to pattern-match or apply the fix elsewhere. Flag it and move on.

8. **Update the JSON.** The JSON task files are the machine-readable state. Always update `status` fields as you work. Other agents and dashboards may read these files.

## Status Values

| Status | Meaning |
|--------|---------|
| `not_started` | Phase/task has not been touched |
| `in_progress` | Phase has some completed tasks but is not done |
| `completed` | All tasks done and verification passed |
| `blocked` | Cannot proceed (prerequisite incomplete or code mismatch) |
| `skipped` | Intentionally skipped (with documented reason) |

## Error Recovery

If an agent encounters an unexpected state:

1. **JSON parse error in task file:** Re-read the file. If corrupted, regenerate from `findings.jsonl` filtered by phase number.
2. **File not found:** The file may have been renamed or deleted. Set task to `blocked` with reason `"file_not_found"`.
3. **Verification command fails to run:** Check that you are in the project root directory. The commands assume `cwd` is the repo root.
4. **Multiple tasks on the same line:** Apply them in ID order (lowest ID first). After each application, re-read the file as line numbers may shift.
5. **Circular dependency detected:** This should not happen with the standard DAG. If it does, report it as a bug in the audit generation.

**Error Recovery Scenarios:**

6. **Line numbers shifted after applying earlier tasks in the same file:** Apply tasks in descending line-number order (highest first). If you cannot reorder due to dependencies, re-read the file after each edit to get current line numbers.

7. **Verification passes but tasks are still blocked:** The verification command is too loose. Report this as an audit bug — the verification command needs updating. Do NOT mark the phase complete.

8. **`target_code` references a function/file that does not exist yet:** Check if another task in the SAME phase creates it. If so, apply the creation task first. If the dependency is in a DIFFERENT phase, the finding was assigned to the wrong phase — flag as phase assignment bug.
```

---

## 5. rasengan-config.json Template

Generated by rinnegan in `data/rasengan-config.json`. Controls how Rasengan executes the remediation pipeline.

```json
{
  "commit_strategy": "per-phase",
  "session_bridging": "json",
  "stale_fix_mode": "adapt",
  "mini_scan_after_phase": true,
  "sharingan_after_phase": false,
  "sharingan_after_all": true,
  "max_retries_per_phase": 2,
  "max_retries_per_task": 1
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `commit_strategy` | string | `per-phase` (one commit per completed phase) or `per-task` (one commit per task). Default: `per-phase`. |
| `session_bridging` | string | `json` (task status persisted to JSON after each task). Always `json`. |
| `stale_fix_mode` | string | `adapt` (5-step search for shifted violations) or `strict` (exact line match only). Default: `adapt`. |
| `mini_scan_after_phase` | bool | Run `/rinnegan --scope files` on modified files after each phase to catch new violations. Default: `true`. |
| `sharingan_after_phase` | bool | Run `/sharingan` after each phase. Default: `false` (expensive). |
| `sharingan_after_all` | bool | Run `/sharingan` after all phases complete. Default: `true`. |
| `max_retries_per_phase` | int | Max retry attempts for phase verification failures. Default: `2`. |
| `max_retries_per_task` | int | Max retry attempts for a single task fix failure. Default: `1`. |

## 6. rasengan-state.json Template

Created by Rasengan at runtime in `data/rasengan-state.json`. Tracks session-level progress for resumption.

```json
{
  "started_at": "2026-03-16T10:00:00Z",
  "last_updated": "2026-03-16T10:45:00Z",
  "current_phase": 2,
  "current_task_id": "TYP-015",
  "phases_completed": [0, 1],
  "total_tasks": 176,
  "tasks_resolved": 42,
  "tasks_skipped": 3,
  "tasks_failed": 0,
  "session_count": 1,
  "status": "in_progress"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `started_at` | string | ISO timestamp of first Rasengan invocation. |
| `last_updated` | string | ISO timestamp of last state write. |
| `current_phase` | int | Phase currently being executed. |
| `current_task_id` | string | Last task that was in progress or completed. |
| `phases_completed` | array | List of phase numbers fully completed. |
| `total_tasks` | int | Total task count across all phases. |
| `tasks_resolved` | int | Tasks with resolution `applied`, `line-shifted`, or `already_resolved`. |
| `tasks_skipped` | int | Tasks with resolution `skipped`. |
| `tasks_failed` | int | Tasks with resolution `failed`. |
| `session_count` | int | Number of Rasengan sessions (incremented on each resume). |
| `status` | string | `in_progress`, `completed`, or `paused` (session exhaustion). |

---

## Template Usage Notes

- Generators MUST replace all `{{PLACEHOLDER}}` values with actual data.
- No placeholder should remain in the final output.
- If a section has zero entries (e.g., no new files to create), include the section header with a note: "None for this audit."
- All file paths in findings are relative to the project root.
- All verification commands assume `cwd` is the project root.
- LOC counts exclude blank lines and comments unless stated otherwise.
