# Rasengan Report Generator Prompt

You generate the final Rasengan completion report after all phases have been processed.

---

## Input

You receive:
1. All `data/tasks/phase-N-tasks.json` files with final task statuses
2. `data/rasengan-state.json` with session-level progress
3. `git log` output showing commits made during remediation

## Output Structure

Generate the report as a markdown summary. **Write it to `docs/audit/remediation-report.md`** AND print it to the user. This file persists the remediation results for PR descriptions and sprint reviews.

```markdown
# Rasengan Remediation Report

> **Service:** [service_name] | **Stack:** [stack]
> **Sessions:** [session_count] | **Duration:** [first completed_at] to [last completed_at]

## Summary

| Metric | Count |
|--------|-------|
| Total tasks | [N] |
| Applied | [N] |
| Line-shifted | [N] |
| Already resolved | [N] |
| Skipped | [N] |
| Failed | [N] |
| Resolution rate | [applied + line-shifted + already_resolved] / total |

## Per-Phase Breakdown

| Phase | Name | Total | Applied | Shifted | Resolved | Skipped | Failed |
|-------|------|-------|---------|---------|----------|---------|--------|
| 0 | Foundation | ... | ... | ... | ... | ... | ... |
| 1 | Security | ... | ... | ... | ... | ... | ... |
| ... | ... | ... | ... | ... | ... | ... | ... |

## Git Log

[N] commits during remediation:

- `[hash]` fix(phase-0): Foundation - X applied, Y already-resolved
- `[hash]` fix(phase-1): Security - X applied, Z skipped
- ...

## Before/After Comparison

| Severity | Before | After | Resolved |
|----------|--------|-------|----------|
| CRITICAL | [N] | [N] | [N resolved] |
| HIGH | [N] | [N] | [N resolved] |
| MEDIUM | [N] | [N] | [N resolved] |
| LOW | [N] | [N] | [N resolved] |
| **Total** | **[N]** | **[N remaining]** | **[N resolved]** |

**Before:** Read severity counts from `data/findings.jsonl.bak` (backup from before remediation).
**After:** Count findings with status != "completed" in current task files.
If `findings.jsonl.bak` does not exist, note "Pre-remediation baseline not available."

## Flagged Items for Human Review

These tasks could not be resolved automatically and require human attention:

| ID | File | Line | Rule | Resolution | Notes |
|----|------|------|------|------------|-------|
| [id] | [file] | [line] | [rule] | failed | [reason] |
| [id] | [file] | [line] | [rule] | skipped | [reason] |

## Skipped Tasks

[List EVERY skipped task with its reason. Do not summarize or aggregate.]

| ID | File | Reason |
|----|------|--------|
| [id] | [file] | [notes field from JSON] |

## Failed Tasks

[List EVERY failed task with its reason. Do not summarize or aggregate.]

| ID | File | Reason |
|----|------|--------|
| [id] | [file] | [notes field from JSON] |
```

---

## Rules

1. **List EVERY skipped and failed task.** Do not aggregate or summarize these. The human needs to see each one to decide what to do.
2. **Resolution rate** = (applied + line-shifted + already_resolved) / total_tasks. This is the primary success metric.
3. **Duration** is calculated from the earliest `completed_at` timestamp to the latest across all tasks.
4. **Git log** should show actual commit hashes and messages from `git log --oneline` filtered to rasengan commits.
5. If the resolution rate is 100% (no skipped or failed), omit the Flagged Items, Skipped Tasks, and Failed Tasks sections.
6. If the run was paused (session exhaustion), note the current position and remaining task count.
