# Engineering Rules Checklist

After every fix Rasengan applies, run through this checklist. A fix that resolves one violation but introduces another is a net zero -- or worse, a regression in a different phase.

---

## Per-Rule Self-Check Table

After applying a fix, check every applicable rule below. The "Check" column describes what to verify. The "How" column gives the concrete grep or read command.

| Rule | Name | Check After Fix | How |
|------|------|-----------------|-----|
| R01 | SSOT & DRY | Did the fix introduce duplication? | Grep for the new code pattern in other files. If the same logic now exists in 2+ places, extract to a shared utility. |
| R02 | Separation of Concerns | Did the fix mix concerns? | Verify the modified file stays in its architectural layer. A service file should not import UI components. A route file should not contain business logic. |
| R03 | Mirror Architecture | Does the fix match existing patterns? | Check: naming conventions match neighbors, import style matches file, indentation matches, error handling pattern matches existing code in the same module. |
| R04 | Performance First | Did the fix add unnecessary complexity? | Check for new N+1 patterns, unnecessary loops, missing memoization (React), or vectorization opportunities (Python). |
| R05 | Security | Did the fix introduce security issues? | Grep for: hardcoded secrets, `eval()`, `exec()`, unsanitized user input, `dangerouslySetInnerHTML`, `verify=False`, `shell=True`. |
| R07 | Strict Typing | Does the fix have proper types? | Grep for `any`/`Any`/`Object`/`!` in modified lines. All function parameters and return types must be annotated. |
| R08 | Build/Test Gate | Does the fix compile and pass tests? | Run the relevant build/lint command for the stack after completing the phase. |
| R09 | Clean Code | Is the fix clean? | No banner comments (`# ===`), no noise comments, no `console.log`/`print()` debug statements, no TODO/FIXME added. |
| R10 | Whole-System Refactors | Are all dependents updated? | If the fix renamed something or changed an interface, grep for all callers and update them. No mixed states. |
| R11 | Documentation | Does the fix require doc updates? | If behavior or API changed, update relevant READMEs/docstrings. |
| R12 | Real Data | Does the fix use real data? | No hardcoded fallback values, no fake data, no placeholder strings unless explicitly part of the spec. |
| R13 | No Magic Numbers | Does the fix use constants? | No inline numeric literals, no hardcoded string values. Extract to named constants or SSOT config. |
| R14 | Clean Build | Does the fix compile/lint? | The modified file must pass the stack's linter and type-checker individually. |
| R16 | Full Stack Verification | Are all layers consistent? | If the fix touches an API contract (route, type, schema), verify that all consuming layers are updated. |
| R20 | Alias Imports | Does the fix use correct import paths? | No `../` parent-relative imports, no `@/*` catch-all alias. All cross-directory imports use semantically-named tsconfig `paths` aliases. |
| R21 | Barrels Outside-Only | Are barrels used correctly? | No same-domain barrel imports — use deep imports within a domain. Check for new circular imports: run `madge --circular` or equivalent. |

---

## Process Rules (Not Code-Scannable)

These rules govern workflow and process. Rasengan cannot detect or fix them via code edits, but the executor should be aware of them:

| Rule | Name | What It Governs | How Rasengan Respects It |
|------|------|-----------------|--------------------------|
| R06 | Plan -> Approve -> Audit | Workflow: propose, get approval, implement, self-audit | Rasengan follows the plan from rinnegan. Each phase is verified before proceeding. |
| R15 | No Estimates | Never estimate time or duration; size work in countable units (files, commands, steps, call sites) | Rasengan does not estimate remaining time. It reports task counts only. |
| R17 | Validate Logging | Every commit has a Tier-1 log entry before completion is claimed | `fix(phase-N)` commits go through the normal commit path, so the Tier-1 hook logs them; rasengan never bypasses hooks. |
| R18 | Never Mention AI | No AI attribution in commits, code, or comments | Rasengan commit messages use `fix(phase-N):` format with no agent attribution. |
| R19 | Spec Verification | Verify every requirement before claiming complete | Rasengan verifies each task via self-check and phase verification command. |
| R22 | Semantic Code Search | Use semble for exploratory lookups | Rasengan uses semble search for file discovery; grep for exact-literal confirmation only. |
| R23 | Plan-Mode Discipline | Non-trivial tasks start in plan mode | Rasengan operates post-plan; the executor must have produced a TaskCreate tasklist before exiting plan mode. |
| R24 | Superpowers Skill Gates | Were required skills invoked at each phase gate? | Check against the R24 trigger map in CODING_RULES.md (the map lives there only). |

These rules are satisfied by the rasengan pipeline design itself, not by per-fix checks.

---

## Quick Grep Patterns Per Stack

### Python

```bash
# R07: Any in public signatures (excluding imports and comments)
grep -n '\bAny\b' "$FILE" | grep -v '#' | grep -v 'import'

# R05: Security red flags
grep -n 'verify=False\|eval(\|exec(\|shell=True\|password.*=.*["\x27]' "$FILE"

# R09: Banner comments and debug prints
grep -n '^# ===\|^# ---\|^# \*\*\*\|print(\|pprint(' "$FILE" | grep -v 'def \|class '

# R13: Magic numbers (numeric literals not in constants)
grep -n '[^a-zA-Z_][0-9]\{2,\}[^a-zA-Z_]' "$FILE" | grep -v '#\|import\|line\|version\|\.0\b'

# R01: Potential duplication (search for new function/class names elsewhere)
grep -rn 'def NEW_FUNCTION_NAME' . --include='*.py'
```

### TypeScript

```bash
# R07: any type usage (excluding comments and imports)
grep -n '\bany\b' "$FILE" | grep -v '//\|import\|/\*'

# R05: Security red flags
grep -n 'dangerouslySetInnerHTML\|eval(\|innerHTML\s*=' "$FILE"

# R09: Console statements
grep -n 'console\.\(log\|warn\|error\|debug\|info\)' "$FILE" | grep -v '//'

# R13: Magic numbers
grep -n '[^a-zA-Z_"][0-9]\{2,\}' "$FILE" | grep -v '//\|import\|version\|index\|length'

# R01: Potential duplication
grep -rn 'function NEW_FUNCTION_NAME\|const NEW_FUNCTION_NAME' . --include='*.ts' --include='*.tsx'
```

### Java

```bash
# R07: Raw types
grep -n 'Map[^<]\|List[^<]\|Set[^<]' "$FILE" | grep -v '//\|import\|@'

# R05: Security red flags
grep -n 'Runtime.exec\|ProcessBuilder\|@SuppressWarnings' "$FILE"

# R09: Debug statements
grep -n 'System.out.print\|System.err.print\|e.printStackTrace' "$FILE"

# R13: Magic numbers
grep -n '[^a-zA-Z_"][0-9]\{2,\}' "$FILE" | grep -v '//\|import\|@\|version'
```

---

## Common Fix-Introduces-Violation Patterns

These are the most frequent ways a fix accidentally creates a new violation:

### Extracting a shared utility (R01 fix) that lacks types (R07 violation)
After creating a shared function to eliminate duplication:
- Does the new function have full type annotations?
- Does the new file have proper imports?
- Is the function name consistent with naming conventions (R03)?

### Replacing a magic number (R13 fix) with a poorly named constant
After extracting `30` to a constant:
- Is the constant name descriptive? (`TIMEOUT_SECONDS`, not `THIRTY`)
- Is the constant in the right SSOT location? (R01)
- Is the constant typed? (`TIMEOUT_SECONDS: int = 30`, not just `TIMEOUT_SECONDS = 30`)

### Adding type annotations (R07 fix) that use `Any` as escape hatch
After adding types to a function:
- Did you use `Any` anywhere? That is not a fix, that is a deferral.
- Are the types precise? `Dict[str, Any]` is often wrong -- what are the actual value types?

### Fixing a security issue (R05 fix) that breaks the API contract
After removing `verify=False` or adding input validation:
- Does the fix change the function signature?
- Are all callers updated? (R16)
- Does the error handling match existing patterns? (R03)

### Removing dead code (R10 fix) that was actually imported elsewhere
Before deleting:
- Grep for all references to the symbol being removed
- Check re-exports (index files, `__init__.py`)
- Check test files that may import it

---

## Verification Commands Per Stack

After completing a phase, run these commands to verify no new violations were introduced:

### Python
```bash
# Type check modified files
mypy --no-error-summary "$FILE"
# Lint modified files
ruff check "$FILE"
```

### TypeScript
```bash
# Type check (project-level, checks modified files)
bunx tsc --noEmit
# Lint modified files
bunx eslint "$FILE"
```

### Java
```bash
# Compile check
mvn compile -pl "$MODULE" -q
# Lint
mvn checkstyle:check -pl "$MODULE" -q
```

---

## Engineering Rules Reference

*Generated from `rules.json` by `render-rules.ts` — do not hand-edit this section.*

<!-- RULES:START -->
### Code Quality
**R01** — SSOT & DRY
**R02** — Separation of Concerns
**R03** — Mirror Architecture
**R04** — Performance First
**R07** — Strict Typing
**R09** — Clean Code
**R10** — Whole-System Refactors
**R12** — Real Data
**R13** — No Magic Numbers
**R14** — Clean Build
**R20** — Alias Imports, No Parent-Relative, No Catch-All
**R21** — Barrels Are Outside-Only, No Cycles
**R25** — Test Quality Bar
**R30** — Simplicity First
**R31** — Surgical Changes
**R34** — Mark Intentional Simplifications

### Process
**R06** — Plan -> Approve -> Audit
**R08** — Build/Test Gate
**R11** — Documentation
**R15** — No Estimates
**R16** — Full Stack Verification
**R17** — Validate Logging
**R19** — Spec Verification Before Completion
**R22** — Semantic Code Search
**R23** — Plan-Mode Discipline
**R24** — Superpowers Skill Gates
**R26** — Pre-Large-Change Reflection Checkpoint
**R27** — Architect-Facing Decision Request Protocol
**R29** — Web Access - Match the Task to the Tool
**R32** — Goal-Driven Execution
**R33** — Sole Package Managers
**R35** — Commit Cadence
**R36** — Claim Provenance & Honest Uncertainty
**R37** — Outcome-First Delivery
**R38** — Impeccable UX Governing Layer
**R39** — Downstream Fault Triage
**R40** — ADHD Output Shape
**R41** — Orchestrator Model Tiering
**R42** — Artifact Deliverables Skip Software Process

### Safety
**R05** — Security
**R18** — Never Mention AI
**R28** — No Destructive Delete Without Approval
<!-- RULES:END -->
