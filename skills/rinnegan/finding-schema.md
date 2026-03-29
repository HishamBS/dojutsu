# Finding Schema

## JSONL Format

Each finding is one JSON object per line in `findings.jsonl`:

```json
{
  "id": "SEC-001",
  "rule": "R05",
  "severity": "CRITICAL",
  "category": "security",
  "file": "app/core/tools/auth_service.py",
  "line": 142,
  "end_line": 142,
  "snippet": "httpx.Client(timeout=10.0, verify=False)",
  "current_code": "httpx.Client(timeout=10.0, verify=False)",
  "description": "TLS certificate validation disabled. Attacker can MITM external API calls.",
  "explanation": "When verify=False is set, the HTTP client does not check if the server's SSL certificate is valid. This means an attacker on the same network can pretend to be the real server and intercept all data sent and received. This is OWASP A07 (Identification and Authentication Failures).",
  "target_code": "get_sync_client(timeout=HTTP_AUTH_TIMEOUT)",
  "target_import": "from app.core.utils.http_client import get_sync_client",
  "search_pattern": "verify=False",
  "phase": 1,
  "effort": "low",
  "layer": "services",
  "scanner": "services-layer",
  "completed_at": null,
  "resolution": null,
  "actual_line": null,
  "notes": ""
}
```

## Field Definitions

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | `{PREFIX}-{NNN}` assigned during aggregation |
| `rule` | Yes | string | Engineering rule ID (R01-R20) |
| `severity` | Yes | enum | CRITICAL / HIGH / MEDIUM / LOW / REVIEW |
| `category` | Yes | string | Category slug (see prefix mapping) |
| `file` | Yes | string | Relative path from project root |
| `line` | Yes | int | Start line number of the violation |
| `end_line` | No | int | End line for multi-line violations |
| `snippet` | Yes | string | Actual violating code (3-5 lines max) |
| `current_code` | Yes | string | The exact code at the violation line that will be replaced. Used by Rasengan as Edit tool `old_string`. Must be an exact substring of the file at cited line. |
| `description` | Yes | string | One-line summary of what is wrong |
| `explanation` | Yes | string | Junior-friendly WHY explanation (2-4 sentences) |
| `target_code` | No | string | The corrected code (if known) |
| `target_import` | No | string | New import needed for the fix |
| `fix_plan` | No | array | Multi-step fix plan for complex/architectural findings. Array of step objects, each with: `step` (int), `action` (create/edit/delete), `file` (string), `description` (string), `code` or `old_code`+`new_code` (strings). Used when `target_code` cannot express the fix as a single replacement. Rasengan executes steps sequentially. |
| `phase` | Yes | int | Remediation phase (0-10) |
| `effort` | Yes | enum | low / medium / high |
| `layer` | Yes | string | Architectural layer this file belongs to (from inventory) |
| `scanner` | Yes | string | Which scanner produced this finding |
| `search_pattern` | Yes | string | Grep-able pattern that identifies this violation (e.g., "verify=False"). Used by Rasengan for stale-fix detection when line numbers shift. |
| `completed_at` | No | string | ISO timestamp when Rasengan resolved this task. Null until resolved. |
| `resolution` | No | string | How Rasengan resolved: `applied` / `line-shifted` / `already_resolved` / `skipped` / `failed`. Null until resolved. |
| `actual_line` | No | int | If line shifted from original, the actual line where fix was applied. Null if no shift. |
| `notes` | No | string | Rasengan notes for flagged/skipped items. Empty string by default. |

## Minimum Content Lengths

| Field | Minimum |
|-------|---------|
| explanation | 2 sentences, at least 30 words |
| snippet | 40 characters, at least 1 complete line |
| description | At least 8 words |
| target_code | Required for LOW/MEDIUM/HIGH when fix is mechanical. Optional only for REVIEW severity or architectural judgment calls. |

## Effort Level Definitions

| Level | Definition | Examples |
|-------|-----------|----------|
| low | Single-line change, <15 min, no tests needed | Rename, add annotation, replace constant |
| medium | 1-3 files, 15-60 min, may need test updates | Extract utility, add validation, refactor function |
| high | 4+ files or architectural, >60 min, new abstractions | New service layer, auth redesign, DB schema change |

## Fix Specification Policy

Every finding MUST have EITHER `target_code` OR `fix_plan` populated. Both null = SCANNER FAILURE.

| Fix Complexity | Use | Example |
|----------------|-----|---------|
| Single-line or single-block replacement | `target_code` (string) | Remove console.log, replace magic number, add type annotation |
| Multi-file refactor, create new file, move code | `fix_plan` (array of steps) | Extract shared type, consolidate duplicates, split god component |
| Truly ambiguous architectural decision | Both null + severity REVIEW | "Should this module be split into microservices?" |

`target_code` null is ONLY acceptable when `fix_plan` is provided OR severity is REVIEW.
Scanners producing >5% of findings with BOTH null = low-quality output requiring re-dispatch.

### fix_plan Schema

```json
{
  "fix_plan": [
    {
      "step": 1,
      "action": "create",
      "file": "src/types/shared/user.ts",
      "code": "export interface UserType {\n  id: string;\n  name: string;\n  email: string;\n}",
      "description": "Create canonical UserType definition"
    },
    {
      "step": 2,
      "action": "edit",
      "file": "src/modules/auth/types.ts",
      "old_code": "interface UserType { id: string; name: string; email: string; }",
      "new_code": "export { UserType } from '@/types/shared/user';",
      "description": "Replace duplicate definition with re-export from canonical source"
    },
    {
      "step": 3,
      "action": "delete",
      "file": "src/modules/dashboard/types/legacy-user.ts",
      "description": "Remove deprecated duplicate file"
    }
  ]
}
```

Step actions:
- `create`: Create a new file with `code` content. Use Write tool.
- `edit`: Replace `old_code` with `new_code` in `file`. Use Edit tool.
- `delete`: Remove the file. Use Bash `rm`.
- `move`: Move code from one file to another (combine with create+edit).

## Severity Levels

| Level | Definition | Examples | Phase Priority |
|-------|-----------|----------|----------------|
| **CRITICAL** | Production will break, data loss, or security exploit possible | `verify=False`, SQL injection, missing auth, runtime crash | Phase 0-1 |
| **HIGH** | Significant risk, fix before next release | SSOT violations causing drift, broad exception swallowing, type mismatches | Phase 1-3 |
| **MEDIUM** | Code quality issue, fix during normal development | Magic numbers, banner comments, deprecated patterns | Phase 4-6 |
| **LOW** | Style or minor improvement, fix when touching the file | Old-style imports, naming conventions, minor inconsistencies | Phase 5-10 |
| **REVIEW** | Scanner uncertain — needs human judgment | Ambiguous patterns, context-dependent decisions | Triage manually |

## Category Prefix Mapping

| Prefix | Category | Rules | Phase |
|--------|----------|-------|-------|
| SEC | security | R05 | 1 |
| TYP | typing | R07 | 2 |
| DRY | ssot-dry | R01 | 3 |
| ARC | architecture | R02, R03 | 4 |
| CLN | clean-code | R09, R13 | 5 |
| PRF | performance | R04 | 6 |
| DAT | data-integrity | R12 | 7 |
| REF | refactoring | R10 | 8 |
| STK | full-stack | R16, R08 | 9 |
| DOC | documentation | R11 | 10 |
| BLD | build | R14 | 0 |

## Phase Assignment Rules

Each finding maps to exactly one phase based on its primary rule:

| Rule | Phase | Phase Name |
|------|-------|------------|
| R14 | 0 | Foundation (Clean Build) |
| R05 | 1 | Security |
| R07 | 2 | Typing |
| R01 | 3 | SSOT/DRY |
| R02, R03 | 4 | Architecture |
| R09, R13 | 5 | Clean Code |
| R04 | 6 | Performance |
| R12 | 7 | Data Integrity |
| R10 | 8 | Refactoring |
| R16, R08 | 9 | Verification |
| R11 | 10 | Documentation |

When a finding involves multiple rules, assign to the LOWEST phase number (fix the most foundational issue first).

## Finding to Task Transformation

When the JSON Generator creates `data/tasks/phase-N-tasks.json`, it transforms each finding from `findings.jsonl` as follows:

| Finding Field | Task Field | Transformation |
|---------------|------------|----------------|
| `id` | `id` | Direct copy |
| `rule` | `rule` | Direct copy |
| `severity` | `severity` | Direct copy |
| `file` | `file` | Direct copy |
| `line` | `line` | Direct copy |
| `current_code` | `current_code` | Direct copy |
| `target_code` | `target_code` | Direct copy (may be null) |
| `target_import` | `imports_needed` | Wrap in array: `[target_import]`. If null, set to `[]`. |
| `search_pattern` | `search_pattern` | Direct copy |
| `explanation` | `explanation` | Direct copy |
| `effort` | `effort` | Direct copy |
| `fix_plan` | `fix_plan` | Direct copy (array of step objects, may be null) |
| `group` | `group` | Direct copy (from aggregation) |
| — | `status` | Initialize to `"pending"` |
| — | `completed_at` | Initialize to `null` |
| — | `resolution` | Initialize to `null` |
| — | `actual_line` | Initialize to `null` |
| — | `notes` | Initialize to `""` |

Fields NOT copied to tasks: `category`, `end_line`, `snippet` (snippet is for human display; `current_code` is for machine use), `scanner`, `layer`, `phase` (already grouped by phase), `cross_cutting`.

## Verification Command Specification

Each `data/tasks/phase-N-tasks.json` must include a `verification` object with a command that proves the phase is complete.

### Command Generation Rules

The verification command must check that NO violations of that phase's rule set remain in the codebase:

| Phase | Rule | Verification Command Pattern |
|-------|------|------------------------------|
| 0 | R14 | Build/compile command for the stack (e.g., `python3 -m py_compile app/**/*.py`) |
| 1 | R05 | `grep -rn 'verify=False\|eval(\|exec(\|shell=True' app/ \| wc -l` expecting `0` |
| 2 | R07 | Stack-specific type check (e.g., `grep -rn '\bAny\b' app/ --include='*.py' \| grep -v import \| wc -l`) |
| 3 | R01 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |
| 4 | R02,R03 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |
| 5 | R09,R13 | `grep -rn '^# ===\|console\.log' app/ \| wc -l` expecting `0` |
| 6 | R04 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |
| 7 | R12 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |
| 8 | R10 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |
| 9 | R16,R08 | Build + test command for the stack |
| 10 | R11 | Manual review — set command to `echo MANUAL_REVIEW_REQUIRED` |

For phases with `MANUAL_REVIEW_REQUIRED`, the verification is advisory. Rasengan treats these as PASS but logs a note.

### Verification Object Schema

```json
{
  "verification": {
    "command": "grep -rn 'verify=False' app/ | wc -l",
    "expected": "0",
    "description": "No verify=False anywhere in app/"
  }
}
```

- `command`: Shell command to run from project root. Must exit 0.
- `expected`: Expected stdout (whitespace-trimmed). Compared as string equality.
- `description`: Human-readable explanation of what the command checks.

## ID Assignment Algorithm

During aggregation:
1. Sort findings by (phase, file, line)
2. Within each category, assign sequential IDs: SEC-001, SEC-002, ...
3. Cross-cutting findings that appear in 3+ files get a special tag: `"cross_cutting": true`
4. Deduplicate: if two scanners report same file:line, keep the one with higher severity

## JSON Task File Format

Each `data/tasks/phase-N-tasks.json` contains:

```json
{
  "phase": 1,
  "phase_name": "Security (R05)",
  "prerequisites": ["phase-0"],
  "status": "not_started",
  "total_tasks": 20,
  "completed": 0,
  "tasks": [
    {
      "id": "SEC-001",
      "status": "pending",
      "rule": "R05",
      "severity": "CRITICAL",
      "group": "1.1 Replace verify=False with HTTP client factory",
      "file": "app/core/tools/auth_service.py",
      "line": 142,
      "current_code": "httpx.Client(timeout=10.0, verify=False)",
      "target_code": "get_sync_client(timeout=HTTP_AUTH_TIMEOUT)",
      "imports_needed": [
        "from app.core.utils.http_client import get_sync_client",
        "from app.configs.constants import HTTP_AUTH_TIMEOUT"
      ],
      "search_pattern": "verify=False",
      "explanation": "verify=False disables TLS certificate validation...",
      "effort": "low",
      "completed_at": null,
      "resolution": null,
      "actual_line": null,
      "notes": ""
    }
  ],
  "verification": {
    "command": "grep -rn 'verify=False' app/ | wc -l",
    "expected": "0",
    "description": "No verify=False anywhere in app/"
  }
}
```

Task status values: `pending` | `in_progress` | `completed` | `blocked` | `skipped`

**Line-shift handling:** When multiple tasks target the same file, apply them in DESCENDING line-number order (highest line first). This prevents earlier edits from shifting line numbers of tasks not yet applied. If tasks have interdependencies within the same file, re-read the file after each edit to recalculate current line numbers.

## phase-dag.json Format

```json
{
  "nodes": [
    {"id": 0, "name": "Foundation", "rules": ["R14"]},
    {"id": 1, "name": "Security", "rules": ["R05"]},
    {"id": 2, "name": "Typing", "rules": ["R07"]}
  ],
  "edges": [
    {"from": 0, "to": 1},
    {"from": 0, "to": 2},
    {"from": 1, "to": 3},
    {"from": 2, "to": 3}
  ]
}
```

## config.json Format

```json
{
  "service": "orchestrator",
  "stack": "python",
  "framework": "fastapi",
  "date": "2026-03-15",
  "total_files": 129,
  "total_loc": 19068,
  "rules_applied": ["R01","R02","R03","R04","R05","R07","R08","R09","R10","R11","R12","R13","R14","R16"],
  "custom_rules": [],
  "total_findings": 176,
  "severity_counts": {"CRITICAL": 22, "HIGH": 58, "MEDIUM": 88, "LOW": 8},
  "density_per_kloc": 9.2
}
```

### Readiness Calculation Formula

```
readiness_pct = 100 - (
  (critical_count * 10) +
  (high_count * 3) +
  (medium_count * 1) +
  (low_count * 0.2)
) / max(total_loc_kloc, 1)

readiness_pct = max(0, min(100, round(readiness_pct, 1)))
```

Example: 9 CRITICAL + 281 HIGH + 720 MEDIUM + 353 LOW on 116 KLOC:
= 100 - (90 + 843 + 720 + 70.6) / 116 = 100 - 14.9 = **85.1%**

This value is written to `config.json` as `readiness_pct` by the aggregator.

## inventory.json Schema

The `data/inventory.json` file describes the codebase structure with LOC counts per file and layer.

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `root` | string | Project root directory name |
| `total_files` | int | Total number of source files inventoried |
| `total_loc` | int | Total lines of code across all files |
| `layers` | object | Map of layer name to `{ "files": [...], "loc": int }`. Each layer lists its file paths and aggregate LOC. |
| `files` | array | Array of `{ "path": string, "loc": int, "layer": string }` for every inventoried file |

Example:

```json
{
  "root": "orchestrator",
  "total_files": 129,
  "total_loc": 19068,
  "layers": {
    "routes": { "files": ["app/api/routes/auth.py", "app/api/routes/chat.py"], "loc": 1240 },
    "services": { "files": ["app/services/llm_service.py"], "loc": 3200 }
  },
  "files": [
    { "path": "app/api/routes/auth.py", "loc": 280, "layer": "routes" },
    { "path": "app/services/llm_service.py", "loc": 540, "layer": "services" }
  ]
}
```
