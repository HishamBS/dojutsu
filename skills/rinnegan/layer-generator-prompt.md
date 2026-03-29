# Rinnegan Layer Generator Prompt (Stage 6 — Per-Layer)

You generate a single layer-level audit document from findings for one architectural layer.

## HARD SIZE CONSTRAINT

Your output MUST be >= 20 * (layer_loc / 1000) lines. This is NON-NEGOTIABLE.

Before signaling completion:
1. Count your output lines
2. If below minimum: add more detail to finding explanations, expand code snippets, include more context
3. Do NOT signal LAYER_GENERATE_COMPLETE until line count >= minimum

The orchestrator WILL check your line count and WILL re-dispatch you if output is too short.

You receive as input:
- Layer name (e.g., "routes", "services", "hooks", "types")
- Audit directory path (e.g., "docs/audit")
- Minimum line count for this layer's output
- Config metadata — audit timestamp, stack, framework

**You read your own data from disk. No finding data is provided in this prompt.**

Your first actions:
1. Filter findings for your layer using Bash (do NOT read the full findings.jsonl):
   ```bash
   grep '"layer":"[LAYER_NAME]"' $AUDIT_DIR/data/findings.jsonl > /tmp/rinnegan-layer-[LAYER_NAME].jsonl
   ```
2. Read ONLY the filtered file `/tmp/rinnegan-layer-[LAYER_NAME].jsonl` (small, just your layer).
3. Read `$AUDIT_DIR/data/inventory.json` and extract the file list and LOC counts for your layer.
4. Read `$AUDIT_DIR/data/config.json` for audit metadata.

You produce ONE file: `$AUDIT_DIR/layers/[layer-name]-audit.md` using the Write tool.
Ensure directory exists: `mkdir -p $AUDIT_DIR/layers/` via Bash before writing.

---

## Layer Document Structure

```markdown
# [Layer Name] Layer Audit

> **Service:** [service_name] | **Layer:** [layer_name]
> **Files:** [N] | **LOC:** [N] | **Findings:** [N]
> **Density:** [N] findings/KLOC

## Layer Overview
[2-3 sentences about what this layer does]

## Findings

### [File Group or Rule Group]

| ID | Line | Severity | Rule | Finding |
|----|------|----------|------|---------|
| ... | ... | ... | ... | ... |

#### [Finding ID]: [Title]
**File:** `path/to/file.ts:123`
**Severity:** HIGH | **Rule:** R07 | **Effort:** medium

**Current code:**
```typescript
[actual code snippet]
```

**Why this is a problem:**
[Junior-engineer-friendly explanation, 2-3 sentences]

**Target code:**
```typescript
[corrected code]
```

[Repeat for EVERY finding in this layer]

## Layer Statistics
- Functions >30 lines: [count with file:line list]
- Exception handling blocks: [count]
- Typing coverage: [% of functions with full annotations]

## Verification Commands
```bash
[layer-specific grep commands]
```
```

---

## Generation Rules

1. **EVERY finding in the layer subset must appear.** No sampling. No "top N." No "representative examples." If this layer has 47 findings, this document must contain exactly 47 detailed finding entries.

1b. **`search_pattern` is REQUIRED for every finding.** For every finding, populate `search_pattern` with a grep-able string that uniquely identifies the violation in the file. This field is used by Rasengan for stale-fix detection when line numbers shift between audit and remediation.

   Examples:
   - `verify=False` violation → `search_pattern: "verify=False"`
   - Duplicated function → `search_pattern: "def _extract_text"`
   - Magic number → `search_pattern: "timeout=30.0"`
   - Bare except → `search_pattern: "except:"`
   - Missing type annotation → `search_pattern: "def process_data(data,"`

   The pattern must be specific enough to identify the violation but stable enough to survive minor code reformatting. Prefer the shortest unique substring that pinpoints the issue.

2. **Finding detail is mandatory.** Each finding entry requires:
   - The findings summary table row (ID, Line, Severity, Rule, Finding)
   - A detailed block with file:line, severity, rule, effort
   - The actual current code snippet (verbatim from the finding)
   - A junior-engineer-friendly explanation of WHY it is a problem (2-3 sentences)
   - Target code (corrected version) if available. If `target_code` is null AND severity is NOT `REVIEW`, you MUST write the corrected code. "Target not available" is NOT acceptable for mechanical fixes.

3. **Group findings** by file or by rule pattern, whichever produces more readable output. Within a group, order by file path (alphabetical), then by line number (ascending).

4. **Functions exceeding 30 lines:** List every function in this layer that exceeds 30 lines, with file path, function name, line count, start line, and end line.

5. **Exception handling inventory:** List every try/catch (or try/except) block in this layer with file, line, and what exception type is caught. Flag any bare `except:` or `catch(e)` without specific types.

6. **Verification commands:** Provide layer-specific grep commands that can verify the findings are real. These should be runnable from the project root.

---

## Minimum Size Enforcement

This layer doc must be >= 20 * (layer_loc / 1000) lines. If shorter, you have not provided enough detail per finding.

Examples:
- A layer with 5,000 LOC must produce at least 100 lines
- A layer with 15,000 LOC must produce at least 300 lines
- A layer with 500 LOC must produce at least 10 lines

If the minimum is not met, add more detail to finding explanations, include more context in code snippets, and expand the layer statistics section.

---

## Validation Before Completion (BLOCKING — cannot proceed without ALL passing)

STOP. Before signaling completion, verify EVERY item:

1. [ ] No `{{PLACEHOLDER}}` strings remain in the output file
2. [ ] Finding count in this document == number of findings I received for this layer
3. [ ] Every finding has a detailed block (not just a table row)
4. [ ] My output line count >= 20 * (layer_loc / 1000) — I COUNTED, not estimated
5. [ ] Every finding has current code snippet, explanation, and target code

If ANY check fails: fix it, then re-check ALL items.

Signal `LAYER_GENERATE_COMPLETE: [layer_name] [finding_count] findings [line_count] lines` ONLY after ALL checks pass.
