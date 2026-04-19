---
name: sharingan
description: Use after implementing any batch of code changes, before claiming completion. Mandatory evidence-based QA pipeline with deterministic verification, cross-engine independent verification, and runtime checks. Triggers on completion claims, "done", "all tasks complete", or batch handoff.
---

# Sharingan — Evidence-Based QA Pipeline

## Core Principle

**"Don't trust; require proof."** Every claim must be backed by a deterministic artifact or independent verification. LLM self-reports are NOT evidence.

## Setup

```bash
# Pin the base commit BEFORE starting verification
export SHARINGAN_BASE=$(git rev-parse HEAD)

# Compute project hash for cache files
export PROJECT_HASH=$(echo -n "$PWD" | shasum -a 256 | cut -c1-16)
export CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
mkdir -p "$CACHE_DIR"

# Extract requirements into a pinned JSON file (re-read from disk at each gate, NOT from memory)
# Write: $CACHE_DIR/requirements-${PROJECT_HASH}.json
# Format: [{"req_id":"R1","description":"...","source_file":"...","source_line":N}, ...]
```

**Anti-context-rot rule:** At the START of each gate, re-read the requirements file from disk. Never rely on memory of what requirements said.

---

## Gate 0: Deterministic Build (bash — unfakeable)

```bash
$SKILL_DIR/gates/verify-deterministic.sh "$SHARINGAN_BASE"
```

This auto-detects your project type (TypeScript, Java/Kotlin/Gradle, Python, Rust, Go, Smithy, Shell, Docker) and runs the appropriate checks:
- **Type-check/compile:** tsc, gradle build, mvn compile, mypy/pyright, cargo check, go vet
- **Lint:** eslint, spotlessCheck, ruff/flake8, cargo clippy, golangci-lint, shellcheck
- **Stub/TODO detection:** Language-aware patterns across all comment styles
- **Unsafe type detection:** TS `any`, Python `type: ignore`, Rust `unsafe`, Go `interface{}`
- **Empty function detection:** Language-specific patterns

If no tooling is found for the detected project type, checks are **skipped gracefully** (never fails because a tool is missing).

**BLOCK if exit code > 0.** Fix failures, then re-run. Max 3 iterations.

The LLM cannot fake this gate — it runs real commands with real exit codes.

---

## Gate 1: Spec Compliance (evidence-based)

**Requirements source priority:**
1. If a `requirements-checklist.json` exists for the current project (check via `spsm_checklist_file` from `spsm-hmac-utils.sh`), use it as the authoritative requirements source. Each requirement in the checklist has `id`, `description`, `acceptance_criteria`, and `linear_issue` fields.
2. If a `rasengan-results.json` exists in `docs/audit/data/` (produced by `/rasengan` after audit remediation), use it as the requirements source. Each requirement represents a completed phase with `id`, `description`, `acceptance_criteria`, and `verified_by_rasengan` fields. Verify that rasengan's fixes actually took effect by re-checking each phase's verification command.
3. Otherwise, fall back to reading the plan file specified in the pipeline state or conversation context.

**When using the checklist as requirements source:**
- Verify each requirement against the implementation (existing Gate 1 evidence-based process)
- After verifying a requirement, update the checklist: set `verified_by_sharingan: true` for that requirement
- Use `spsm_checklist_flip` only for the `implemented` field; for `verified_by_sharingan`, use direct jq update:
  ```bash
  # Only when running inside spsm-pipeline (skip if standalone/dojutsu)
  if [[ -f "${HOME}/.config/spsm/hooks/spsm-hmac-utils.sh" ]]; then
    source "${HOME}/.config/spsm/hooks/spsm-hmac-utils.sh"
  fi
  CHECKLIST_FILE=$(spsm_checklist_file 2>/dev/null || echo "")
  jq --arg id "REQ-001" '.requirements |= map(if .id == $id then .verified_by_sharingan = true else . end)' "$CHECKLIST_FILE" > "${CHECKLIST_FILE}.tmp" && mv "${CHECKLIST_FILE}.tmp" "$CHECKLIST_FILE"
  ```
  Note: This modifies the file without re-signing HMAC. The verify function checks HMAC of the content without the hmac field, so this change will invalidate the HMAC. After all verifications, re-sign:
  ```bash
  # Re-sign after all sharingan verifications
  TMP="${CHECKLIST_FILE}.verify"
  jq 'del(.checklist_hmac)' "$CHECKLIST_FILE" > "$TMP"
  HASH=$(shasum -a 256 "$TMP" | cut -c1-64)
  rm -f "$TMP"
  HMAC=$(echo -n "checklist|${HASH}" | openssl dgst -sha256 -hmac "$(_spsm_secret)" | awk '{print $NF}')
  jq --arg hmac "$HMAC" '.checklist_hmac = $hmac' "$CHECKLIST_FILE" > "${CHECKLIST_FILE}.tmp" && mv "${CHECKLIST_FILE}.tmp" "$CHECKLIST_FILE"
  ```

### Step 1: Read requirements file from disk
```bash
cat "$CACHE_DIR/requirements-${PROJECT_HASH}.json"
```
Print: "Gate 1 starting. Verifying [count] requirements from [file path]."

### Step 2: For EACH requirement

1. **Call the Read tool** on the specific file (not "I already read it")
2. Find the exact line implementing this requirement
3. **Compute file hash:** `shasum -a 256 < file | cut -d' ' -f1`
4. Write a JSONL entry to the evidence file:

```jsonl
{"req_id":"R1","status":"VERIFIED","file":"src/...","line":42,"content_sha256":"abc...","actual_content":"the exact line content","tool_call":"Read","timestamp":"2026-..."}
```

### Evidence Rules

- `content_sha256` = SHA-256 of the ENTIRE file at verification time
- `actual_content` = the actual line content read from the file (not from memory)
- `tool_call` = which tool was used (Read, Grep, Bash)
- Status `VERIFIED` requires ALL of: file, line, content_sha256, actual_content, tool_call
- Status `MISSING` or `STUB` triggers automatic fix phase
- **Anti-hallucination:** If you claim VERIFIED without a Read/Grep tool call in this gate iteration for that file, the claim is INVALID

### Shell Detection (Language-Agnostic)

Apply checks based on the file's language. The goal is to detect placeholder code that looks complete but does nothing real.

**TypeScript/JavaScript UI components** (.tsx, .jsx, .vue, .svelte):
- [ ] Event handlers? (onClick, onChange, onSubmit)
- [ ] State management? (useState, useReducer, store hooks, reactive state)
- [ ] Data fetching? (useQuery, fetch, axios, tRPC hooks, SWR)
- [ ] Interactive elements? (inputs, buttons, forms, data tables)
- [ ] Loading/error states? (isLoading, Suspense, error boundary)
- [ ] Conditional rendering? (ternaries, && chains, switch on state)
Fails 4+ = SHELL

**TypeScript/JavaScript services** (.ts, .js):
- [ ] Real logic? (conditionals, loops, error handling)
- [ ] Real DB/API calls? (actual queries, fetch calls)
- [ ] Input validation? (Zod, schemas, type guards)
- [ ] Real return data? (not hardcoded objects)
- [ ] Error paths? (try/catch, Result types)
Fails 3+ = SHELL

**Java/Kotlin** (.java, .kt):
- [ ] Real business logic? (conditionals, domain rules)
- [ ] Repository/service calls with real queries?
- [ ] Input validation? (@Valid, custom validators)
- [ ] Error handling? (exceptions, ResponseEntity)
- [ ] Non-trivial return data?
Fails 3+ = SHELL

**Python** (.py):
- [ ] Real logic? (not just pass or raise NotImplementedError)
- [ ] Database/API operations? (ORM queries, HTTP clients)
- [ ] Input validation? (Pydantic, serializers)
- [ ] Error handling? (try/except, HTTPException)
Fails 3+ = SHELL

**Go** (.go):
- [ ] Real logic? (not just return nil or empty struct)
- [ ] Error handling? (if err != nil with real messages)
- [ ] Request/response handling? (parsing, encoding)
Fails 3+ = SHELL

**Rust** (.rs):
- [ ] Real logic? (not just todo!() or unimplemented!())
- [ ] Error types? (custom enums, Result handling)
- [ ] Business logic? (match arms, computations)
Fails 3+ = SHELL

**Shell** (.sh, .bash):
- [ ] Argument parsing? (getopts, case, shift)
- [ ] Real commands? (not just echo or exit)
- [ ] Error handling? (set -e, trap, exit codes)
- [ ] Conditional logic? (real conditions, not just pass-through)
Fails 3+ = SHELL

### Fix Loop

MISSING/STUB items -> auto-fix -> re-run Gate 0 (deterministic verifies fix) -> re-check requirement. Max 3 iterations.

---

## Gate 2: Code Correctness (split deterministic + LLM)

### Already validated by Gate 0 (deterministic — skip here):
- H (No incomplete implementation) — caught by stub grep
- J (Strict typing) — caught by unsafe type grep
- L (Anti-stub) — caught by empty function detection

### LLM-judged checks (with mandatory tool calls as evidence):

| Check | What | Evidence Required |
|-------|------|-------------------|
| A | Business logic correct | Cite specific behavior + file:line |
| B | SSOT violations | Grep for duplicates, cite all instances |
| C | Engineering rules | Cite rule number + file:line |
| D | DRY violations | Grep for duplicate code blocks |
| E | No backward compat hacks | Verify no deprecated code remains |
| F | Type consistency | Trace types through file paths |
| G | Security | Cite OWASP category + file:line |
| I | No masking fallbacks | Grep for fallback patterns in the relevant language |
| K | Spec completeness | Re-read requirements file, cross-check |

**Each check MUST produce a tool call (Read/Grep) as evidence.** "I already checked this" is NOT valid evidence.

FAIL -> auto-fix -> re-run Gate 0 -> re-check. Max 3 iterations.

---

## Gate 3: Independent Verification (fresh-context sub-agent — ALWAYS runs)

This is the most critical gate. A SEPARATE agent with ZERO builder context verifies the work independently.

### Known trap — Gate 3 rescope loop

The independent verifier is LLM-driven and **rescopes each run**. Every iteration it may raise NEW literal-compliance nits that weren't flagged the time before — stylistic wording, extra caveats, arbitrarily-tight "could be clearer" suggestions. Chasing these indefinitely is an infinite-loop trap; you will never reach a fixed point.

**Rule: after ONE clean iteration, move on.** The contract is:
1. First run finds real SHELL/MISSING → auto-fix → re-run.
2. Second run finds *only* PARTIAL nits that weren't in pass 1 → this is rescope drift, not a real defect. Proceed directly to `reconcile.sh` and `enforce.sh`.
3. Do NOT chase Gate 3 partials past the first pass. If Gate 3 flips from SHELL/MISSING → PARTIAL → CLEAN is not achievable, treat the PARTIAL pass as the ceiling and let reconciliation resolve.

This is a pragma, not a safety bypass — the other gates (Gate 0 deterministic, Gate 1 evidence-based, Gate 4 runtime) still catch real defects. Gate 3's role is to catch SHELL/MISSING specifically; once those are clean, its job is done.

### How to run:

```bash
# Engine and model are read from SSOT (agent-capabilities.yaml) by the script.
# Override via env: SHARINGAN_VERIFIER_ENGINE, SHARINGAN_VERIFIER_MODEL
# Or via CLI: --engine <codex|claude> --model <model-id>
$SKILL_DIR/gates/verify-independent.sh \
  --plan "[path-to-plan-file]" \
  --base "$SHARINGAN_BASE"
```

### What happens:
1. The script auto-detects project languages from modified files
2. Spawns a fresh-context verifier agent via agent-mux or direct CLI
3. The verifier gets ONLY: the plan content + list of modified files + the project directory
4. The verifier gets ZERO builder reasoning, ZERO gate reports, ZERO previous context
5. The verifier reads ALL files fresh and rates each requirement: IMPLEMENTED / PARTIAL / SHELL / MISSING
6. Shell detection uses language-specific checks (see verify-independent.sh for full checklist per language)
7. Output: `$CACHE_DIR/independent-review-${PROJECT_HASH}.json`

### Disagreement handling:
- Verifier finds SHELL/MISSING where builder found VERIFIED -> auto-fix -> verifier RE-RUNS
- Verifier finds PARTIAL where builder found VERIFIED -> auto-fix for partial aspects
- Max 2 fix-verify cycles. Still SHELL/MISSING after 2 cycles -> BLOCKED

**This gate runs in FOREGROUND. Results MUST be awaited before proceeding.**

---

## Gate 4: Runtime Verification (framework-agnostic — unfakeable)

The only unfakeable SEMANTIC check. Everything before Gate 4 checks code EXISTS and LOOKS correct. Gate 4 checks code actually WORKS.

### Step 1: Generate runtime check template

```bash
$SKILL_DIR/gates/verify-runtime.sh \
  --base "$SHARINGAN_BASE" \
  --port "${PORT:-auto}"
```

This auto-detects your framework (Next.js, Express, FastAPI, Spring, Django, Go, Rust, etc.) and:
- Identifies modified pages/views and API endpoints
- Maps file paths to URLs (best-effort, framework-aware)
- Auto-detects the correct port from .env, docker-compose, or framework defaults
- Outputs a checklist JSON template

### Step 2: Start your dev server

Use your project's standard dev command. Examples:
- `npm run dev`, `yarn dev`, `pnpm dev`
- `./gradlew bootRun`, `mvn spring-boot:run`
- `uvicorn main:app --reload`, `python manage.py runserver`
- `go run .`, `cargo run`

### Step 3: For UI pages (using Playwright MCP):
1. Navigate to each detected page URL
2. Take accessibility snapshot with `browser_snapshot`
3. Check snapshot for: interactive elements, data-bound content, expected element count, no error states
4. If component has interactions: click/fill primary element, verify UI responds

### Step 4: For API endpoints:
1. Construct minimal valid request
2. Call endpoint via appropriate method (curl, fetch, HTTP client)
3. Verify response shape matches schema
4. Verify response contains real data (not empty arrays, not null)

### Step 5: For utilities/libraries:
1. If unit tests exist: run them with the project's test runner
2. If no tests: verify code is imported by a runtime-tested component
3. Orphaned code -> flag as potential dead code

### Special cases:
- **Smithy models**: No runtime to test directly. Verify generated code if codegen is configured.
- **Shell scripts**: Execute with `--help` or `--dry-run` if supported. Verify exit codes.
- **Infrastructure code**: Validate with plan/dry-run commands (terraform plan, cdk diff, etc.)

Write results to: `$CACHE_DIR/runtime-check-${PROJECT_HASH}.json`

FAIL -> auto-fix -> re-run. Max 2 cycles. Still failing -> BLOCKED.

**Practical scoping:** New pages/routes and new API endpoints MUST be runtime-tested. Utility functions can be skipped if type-check + unit tests cover them.

---

## Gate 5: Reconciliation (deterministic — NO LLM judgment)

```bash
$SKILL_DIR/gates/reconcile.sh "$SHARINGAN_BASE"
```

This script:
1. Loads Gate 1 evidence file
2. Loads Gate 3 independent review
3. Loads Gate 4 runtime results
4. Cross-references ALL sources for each requirement
5. Runs `verify-deterministic.sh` one final time (catches regressions from fixes)
6. Writes CLEAR or BLOCKED verdict to `$CACHE_DIR/verdict-${PROJECT_HASH}.json`

**No LLM judgment in Gate 5.** Pure data comparison.

---

## Verdict JSON Format

```json
{
  "verdict": "CLEAR",
  "version": "1.0",
  "timestamp": "2026-...",
  "gates": {
    "gate_0": {"status":"PASS","hard_failures":0},
    "gate_1": {"status":"PASS","requirements_checked":0,"missing":0,"stubs":0,"verified":0},
    "gate_2": {"status":"PASS","checks_run":9,"failures":0},
    "gate_3": {"status":"PASS","verifier_completed":true,"engine":"codex","model":"gpt-5.4","summary":{"implemented":0,"partial":0,"shell":0,"missing":0}},
    "gate_4": {"status":"PASS","ui_checks":0,"api_checks":0,"failures":0},
    "gate_5": {"status":"APPROVED","sources_aligned":true,"final_deterministic":"PASS"}
  }
}
```

---

## Anti-Sycophancy Rules

1. **Inversion framing:** Find every way the code FAILS to match the spec. List ALL failures. An empty failure list must be independently justified.

2. **Penalty framing:** A false VERIFIED is worse than a false MISSING. If you mark VERIFIED and the stop hook finds it's not, the ENTIRE pipeline fails and restarts. It is CHEAPER to mark MISSING and re-verify.

3. **Accuracy over helpfulness:** You are optimized for ACCURACY, not HELPFULNESS. A BLOCKED verdict that catches real issues is MORE VALUABLE than a CLEAR verdict that misses issues.

4. **Calibration anchoring:** In real-world audits, first-pass code ALWAYS has issues. If Gate 1 finds ZERO missing items on the first pass, you are almost certainly hallucinating. Re-check with extra scrutiny.

---

## Anti-Context-Rot Rules

1. **Requirements pinned at start:** Written to `requirements-{hash}.json`, re-read from DISK at each gate boundary
2. **Gate boundary re-anchoring:** At each gate start, re-read requirements file and print count
3. **Pipeline state persisted:** Track current gate + iteration in `pipeline-state-{hash}.json`
4. **Sub-agent scope pinning:** Give sub-agents the requirements FILE PATH, not pasted content

---

## Stop Hook

`$SKILL_DIR/gates/enforce.sh` runs deterministic checks on every conversation end:

**LIGHTWEIGHT mode** (analysis/audit/question sessions — COMMIT_BEFORE not set):
1. Does type-check/compile pass? (auto-detected per project type) (Fail -> BLOCK)
2. Are there stubs/TODOs in modified files? (Found -> BLOCK)

**FULL mode** (implementation sessions — COMMIT_BEFORE set AND HEAD moved):
- F1: Verdict file exists + CLEAR
- F2: HMAC integrity check (project-scoped key, stable across script updates)
- F3: Commit-based staleness (verdict must cover current HEAD)
- F4: Type-check/compile passes (unfakeable, auto-detected)
- F5: No stubs in modified files (all languages)
- F6: Evidence spot-check (adaptive sampling)
- F7: Independent review exists + no SHELL/MISSING
- F8: Runtime check (if exists) has no FAILs
- F9: Verdict gate numbers valid

The stop hook does NOT require a /sharingan verdict for non-implementation sessions.
The full pipeline runs when agents invoke /sharingan after plan implementation.
