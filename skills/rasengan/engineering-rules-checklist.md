# Engineering Rules Checklist

After every fix Rasengan applies, run through this checklist. A fix that resolves one violation but introduces another is a net zero -- or worse, a regression in a different phase.

---

## Per-Rule Self-Check Table

After applying a fix, check every applicable rule below. The "Check" column describes what to verify. The "How" column gives the concrete grep or read command.

| Rule | Name | Check After Fix | How |
|------|------|-----------------|-----|
| protect-secrets | Protect secrets | Did the fix introduce security issues? | Grep for: hardcoded secrets, `eval()`, `exec()`, unsanitized user input, `dangerouslySetInnerHTML`, `verify=False`, `shell=True`. |
| one-outcome-check | One outcome check | Does the fix compile and pass the affected tests? | Run the relevant build/lint command for the stack, and the tests the change touches, after completing the phase. |
| smallest-complete-change | Smallest complete change | Is it the smallest complete change that fits the code around it? | Grep for the new code pattern in other files (duplication); check naming, import style and layer match the neighbours; grep for `any`/`Any`/`Object`/`!` in modified lines; no banner or noise comments, no debug prints; if the fix renamed something or changed an interface, update every caller and affected doc; no hardcoded fallback values, fake data or placeholder strings. |
| live-systems-and-outward-actions | Live systems and outward actions | Did the fix touch a live app, chat, data or notification, or do anything outward? | Run tests on an isolated instance; a push, publish or post needs the operator's yes. |

---

## Process Rules (Not Code-Scannable)

These rules govern workflow and process. Rasengan cannot detect or fix them via code edits, but the executor should be aware of them:

| Rule | Name | What It Governs | How Rasengan Respects It |
|------|------|-----------------|--------------------------|
| brief-then-build | Brief, then build | Short briefs, the ledger as the record, parallel worktrees | Rasengan follows the plan from rinnegan. Each phase is verified before proceeding. |
| no-ai-credit | No AI credit | No AI attribution in commits, code, or comments | Rasengan commit messages use `fix(phase-N):` format with no agent attribution. |
| resolve-first | Resolve first | Resolve from source before asking; say plainly what was not checked | Rasengan reads the code before it asks, and reports what it could not verify. |
| commit-at-seams | Commit at every verified seam | Commit at every verified seam | Rasengan commits each verified phase separately. |

These rules are satisfied by the rasengan pipeline design itself, not by per-fix checks.

---

## Quick Grep Patterns Per Stack

### Python

```bash
# Types: Any in public signatures (excluding imports and comments)
grep -n '\bAny\b' "$FILE" | grep -v '#' | grep -v 'import'

# protect-secrets: Security red flags
grep -n 'verify=False\|eval(\|exec(\|shell=True\|password.*=.*["\x27]' "$FILE"

# Noise: banner comments and debug prints
grep -n '^# ===\|^# ---\|^# \*\*\*\|print(\|pprint(' "$FILE" | grep -v 'def \|class '

# Literals: numeric literals not in constants
grep -n '[^a-zA-Z_][0-9]\{2,\}[^a-zA-Z_]' "$FILE" | grep -v '#\|import\|line\|version\|\.0\b'

# Duplication: search for new function/class names elsewhere
grep -rn 'def NEW_FUNCTION_NAME' . --include='*.py'
```

### TypeScript

```bash
# Types: any type usage (excluding comments and imports)
grep -n '\bany\b' "$FILE" | grep -v '//\|import\|/\*'

# protect-secrets: Security red flags
grep -n 'dangerouslySetInnerHTML\|eval(\|innerHTML\s*=' "$FILE"

# Noise: console statements
grep -n 'console\.\(log\|warn\|error\|debug\|info\)' "$FILE" | grep -v '//'

# Literals: numeric literals not in constants
grep -n '[^a-zA-Z_"][0-9]\{2,\}' "$FILE" | grep -v '//\|import\|version\|index\|length'

# Duplication: search for new function/class names elsewhere
grep -rn 'function NEW_FUNCTION_NAME\|const NEW_FUNCTION_NAME' . --include='*.ts' --include='*.tsx'
```

### Java

```bash
# Types: raw types
grep -n 'Map[^<]\|List[^<]\|Set[^<]' "$FILE" | grep -v '//\|import\|@'

# protect-secrets: Security red flags
grep -n 'Runtime.exec\|ProcessBuilder\|@SuppressWarnings' "$FILE"

# Noise: debug statements
grep -n 'System.out.print\|System.err.print\|e.printStackTrace' "$FILE"

# Literals: numeric literals not in constants
grep -n '[^a-zA-Z_"][0-9]\{2,\}' "$FILE" | grep -v '//\|import\|@\|version'
```

---

## Common Fix-Introduces-Violation Patterns

These are the most frequent ways a fix accidentally creates a new violation:

### Extracting a shared utility (duplication fix) that lacks types
After creating a shared function to eliminate duplication:
- Does the new function have full type annotations?
- Does the new file have proper imports?
- Is the function name consistent with naming conventions?

### Replacing a magic number with a poorly named constant
After extracting `30` to a constant:
- Is the constant name descriptive? (`TIMEOUT_SECONDS`, not `THIRTY`)
- Is the constant in the right SSOT location?
- Is the constant typed? (`TIMEOUT_SECONDS: int = 30`, not just `TIMEOUT_SECONDS = 30`)

### Adding type annotations that use `Any` as escape hatch
After adding types to a function:
- Did you use `Any` anywhere? That is not a fix, that is a deferral.
- Are the types precise? `Dict[str, Any]` is often wrong -- what are the actual value types?

### Fixing a security issue (protect-secrets) that breaks the API contract
After removing `verify=False` or adding input validation:
- Does the fix change the function signature?
- Are all callers updated?
- Does the error handling match existing patterns?

### Removing dead code that was actually imported elsewhere
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
**smallest-complete-change** — Smallest complete change

### Process
**brief-then-build** — Brief, then build
**one-outcome-check** — One outcome check
**resolve-first** — Resolve first
**commit-at-seams** — Commit at every verified seam

### Safety
**protect-secrets** — Protect secrets
**no-ai-credit** — No AI credit
**ask-before-deleting** — Ask before deleting
**live-systems-and-outward-actions** — Live systems and outward actions
<!-- RULES:END -->
