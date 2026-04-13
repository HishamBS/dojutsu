# Cross-Cutting Generator Prompt

## Pre-Computed Statistics (MANDATORY)

Read `[AUDIT_DIR]/data/audit-stats.json` before writing any numbers. Use the `audit_date`
field for dates, `cross_cutting` object for group counts. Do NOT count or compute
statistics yourself — all numbers MUST come from this file.

## Role
You generate cross-cutting.md -- a document covering violation patterns that span multiple architectural layers.

## Input

**You read your own data from disk. No finding data is provided in this prompt.**

You receive:
- Audit directory path (e.g., "docs/audit")

Your first actions:
1. Filter cross-cutting findings using Bash:
   ```bash
   grep '"cross_cutting":true' $AUDIT_DIR/data/findings.jsonl > /tmp/rinnegan-cross-cutting.jsonl
   ```
2. Read ONLY the filtered file `/tmp/rinnegan-cross-cutting.jsonl`.
3. Group filtered findings by their `"group"` field.
4. If no findings have cross_cutting: true, create the file with a note: "No cross-cutting patterns detected."

## Output
`$AUDIT_DIR/cross-cutting.md` — one section per cross-cutting pattern group (use the Write tool).
Ensure directory exists: `mkdir -p $AUDIT_DIR/` via Bash before writing.

## Structure per pattern:

```markdown
# Cross-Cutting Patterns

## Pattern: [Group Name]
**Rule:** [R##] | **Instances:** [N] across [M] layers | **Severity:** [highest]

**What it is:** [1-2 sentence description of the pattern]

**Why it matters:** [Junior-friendly explanation]

**Occurrences:**
| # | File | Line | Layer | Snippet |
|---|------|------|-------|---------|
| 1 | path/to/file.ts | 42 | services | `code snippet` |
| 2 | path/to/other.ts | 88 | hooks | `code snippet` |
| ... | ... | ... | ... | ... |

**Recommended fix:** [Description + target code if applicable]

**Verification:**
```bash
grep command  # Expected: 0
```
```

## Rules
- EVERY cross-cutting group must have its own section.
- EVERY instance within a group must appear in the occurrences table (no sampling).
- Minimum >=50 lines per cross-cutting group.
- If 0 cross-cutting patterns, still create the file with a note: "No cross-cutting patterns detected."
- Order groups by total instance count (highest first).
- Within each group, order occurrences by layer then by file path.

## Validation Before Completion

Before signaling generation complete, verify:

1. No `{{PLACEHOLDER}}` strings remain in the output file.
2. Every cross-cutting group from the input has a section in the output.
3. Every instance within each group appears in the occurrences table.
4. Each group section is >= 50 lines.
5. Signal `CROSSCUTTING_GENERATE_COMPLETE: [group_count] groups [instance_count] instances` only after all checks pass.
