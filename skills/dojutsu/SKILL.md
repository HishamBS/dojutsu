---
name: dojutsu
description: Full automated pipeline -- audit, analyze, fix, verify. Session-resilient, agent-agnostic, HMAC-signed state machine. Chains rinnegan (detect), byakugan (analyze), rasengan (fix), sharingan (verify). Run on any project for complete quality remediation.
---

# Dojutsu -- Unified Codebase Quality Pipeline

## Core Principle

**"The pipeline script is the only authority. Never improvise."**

Dojutsu is a session-resilient, agent-agnostic orchestrator that chains four specialized eyes in strict sequence: rinnegan detects violations, byakugan analyzes dependencies and impact, rasengan fixes findings, sharingan verifies fixes. All state lives on disk with HMAC-signed integrity. Any coding agent (Claude, Codex, OpenCode, Gemini) can run or resume any pipeline at any point.

---

## HARD RULES

These are non-negotiable. Violating any rule corrupts pipeline state or produces incorrect results.

1. **Pipeline script is the sole orchestrator.** Always run `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR` first. Execute only the ACTION it outputs. Run it again. Repeat until COMPLETE. Never skip steps, never improvise, never write your own scripts to generate artifacts.

2. **Never write inline scripts to generate artifacts.** The pipeline handles all file creation. If the pipeline says "run rinnegan", delegate to rinnegan's script, not a hand-rolled substitute.

3. **Never continue from memory of a previous session.** Always run `--status` or the pipeline script to re-establish truth from disk. Memory-based continuation causes drift and state corruption.

4. **HMAC-signed state is immutable by hand.** Never edit `dojutsu-state.json` directly. The pipeline signs every state change. Manual edits trigger HMAC mismatch errors.

5. **Confidence routing is enforced.** HIGH and MEDIUM findings are auto-fixed. LOW findings pause for human review. Do not override this. Do not auto-fix LOW findings.

6. **Budget enforcement is automatic.** When token usage exceeds `session_token_budget` in dojutsu.toml, the pipeline auto-pauses. Start a new session and run with `--resume` or just run the pipeline again. Do not circumvent budget checks.

7. **Git checkpoints are mandatory.** The pipeline tags every stage transition (`dojutsu/*` tags). These enable rollback. Never delete dojutsu git tags during a run.

8. **Sentinel file prevents concurrent runs.** If `.dojutsu-active` exists with a live PID, the pipeline is already running. Wait or investigate the stale process.

9. **Model tiers come from dojutsu.toml.** Never hardcode model IDs. The TOML `[models.tiers]` and `[models.assignments]` sections are the single source of truth for what model handles what task.

---

## Quick Start

```bash
# Audit only (DEFAULT -- safe, no code changes):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR

# Audit + fix (interactive -- approve after each phase):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix

# Fix specific phases only:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix --phases 0,1,2

# Fully autonomous (no approval gates):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --fix --auto

# Resume from saved state:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --resume

# Show current state (read-only):
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --status

# Show report regeneration instructions:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --report

# Remove all audit data for a fresh start:
python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR --clean
```

---

## Flags Reference

| Flag | Requires | Description | Default |
|------|----------|-------------|---------|
| *(none)* | | Audit only. Runs rinnegan + byakugan. No code changes. | Yes |
| `--fix` | | Enable code fixing (rasengan + sharingan loop after audit). | |
| `--phases N,M` | `--fix` | Fix only selected phases (0-indexed). Others are skipped. | All phases |
| `--interactive` | `--fix` | Approve after each phase before continuing. | Default with --fix |
| `--auto` | `--fix` | No approval gates. Fully autonomous end-to-end. | |
| `--resume` | | Resume from saved state and flags. Clears exit_reason. | |
| `--status` | | Show pipeline state without advancing. Read-only. | |
| `--report` | | Show report regeneration instructions. | |
| `--clean` | | Remove `docs/audit/` directory for a fresh start. | |

**Mutual exclusivity:** `--status`, `--report`, and `--clean` are informational commands that do not advance the pipeline. `--auto` and `--interactive` are mutually exclusive.

---

## Pipeline State Machine

```
INACTIVE
    |
    v
RINNEGAN_ACTIVE ──────── scan project, create findings.jsonl + phase tasks
    |
    v
BYAKUGAN_ACTIVE ──────── trace dependencies, generate structured impact checkpoints, compile deep-analysis bundle
    |
    +──> AUDIT_COMPLETE ──── (audit-only mode stops here)
    |
    v
RASENGAN_PHASE_0 ──────── auto-fix HIGH+MEDIUM, human review LOW
    |
    v
SHARINGAN_PHASE_0 ─────── 6-gate verification (deterministic + independent + runtime)
    |                         |
    |   BLOCKED ──────────────+──> back to RASENGAN_PHASE_0 (re-fix)
    |   CLEAR ────────────────+
    |                         v
    +──> RASENGAN_PHASE_1 ──> SHARINGAN_PHASE_1 ──> ... (repeat per phase)
                                                        |
                                                        v
                                                  PIPELINE_COMPLETE
```

### Two Modes

**Audit mode** (default): `rinnegan -> byakugan -> AUDIT_COMPLETE`. No code changes. Safe for read-only exploration.

**Fix mode** (`--fix`): Full pipeline with `[rasengan N -> sharingan N] x phases` loop after the audit.

### Stage Detection

The pipeline detects the current stage from **disk artifacts**, not from memory:

| Stage | Detected by |
|-------|------------|
| RINNEGAN_ACTIVE | `docs/audit/master-audit.md` does not exist |
| BYAKUGAN_ACTIVE | Full deep-analysis package missing: `dependency-graph.json`, `clusters.json`, `impact-analysis.jsonl`, `narrative.md`, `scorecard.md`, `deployment-plan.md`, or `executive-brief.md` |
| RASENGAN_PHASE_N | `rasengan-state.json` shows incomplete phases |
| SHARINGAN_PHASE_N | Completed but unverified phases in `rasengan-state.json` vs `verified_phases` in state |
| PIPELINE_COMPLETE | `rasengan-state.json` status is ALL_PHASES_COMPLETE and all phases verified |

### Delegation Model

Dojutsu does NOT execute eye logic directly. It calls each eye's `run-pipeline.py` as a subprocess, reads its stdout for ACTION instructions or completion signals, and passes those through to you. The eye scripts are the authority for their domain.

---

## Stage-by-Stage Execution Guide

### RINNEGAN_ACTIVE (Scanning)

**What happens:** Pipeline delegates to rinnegan's `run-pipeline.py`. Rinnegan inventories the project, runs grep patterns, dispatches LLM scanners, aggregates findings, enriches with fix instructions, and generates documentation.

**What you do:** Execute the ACTION that the pipeline prints. Agent stages write checkpoint artifacts only. Published docs are compiled deterministically from SSOT data. Run the pipeline script again after each action completes.

**Artifacts produced:**
- `docs/audit/master-audit.md` -- navigation hub
- `docs/audit/layers/*.md` -- per-layer findings
- `docs/audit/phases/*.md` -- per-phase task docs
- `docs/audit/data/findings.jsonl` -- all findings (one JSON per line)
- `docs/audit/data/tasks/phase-N-tasks.json` -- task files for rasengan

**Completion signal:** `EYE_COMPLETE: rinnegan`
**Git tag:** `dojutsu/rinnegan-complete`

### BYAKUGAN_ACTIVE (Analysis)

**What happens:** Pipeline delegates to byakugan's `run-pipeline.py`. Byakugan builds a dependency graph, clusters findings, and dispatches impact analysis agents. The pipeline then compiles the final deep-analysis docs deterministically.

**What you do:** Execute the ACTION the pipeline prints. Dispatch impact analysts only. The deterministic bundle compiler owns the final published docs.

**Artifacts produced:**
- `docs/audit/deep/dependency-graph.json` -- deterministic dependency graph
- `docs/audit/deep/clusters.json` -- deterministic cluster definitions
- `docs/audit/deep/impact-analysis.jsonl` -- blast-radius analysis per cluster
- `docs/audit/deep/narrative.md` -- executive report for stakeholders
- `docs/audit/deep/scorecard.md` -- compliance rating per rule category
- `docs/audit/deep/deployment-plan.md` -- rollout plan with risk assessment
- `docs/audit/deep/executive-brief.md` -- one-page management summary

**Completion signal:** `EYE_COMPLETE: byakugan`
**Git tag:** `dojutsu/byakugan-complete`

**Audit-only mode stops here.** The pipeline prints `AUDIT COMPLETE` with links to all outputs and instructions for switching to fix mode.

### RASENGAN_PHASE_N (Fixing)

**What happens:** Pipeline delegates to rasengan's `run-pipeline.py` for the current phase. Rasengan reads the phase task file and tells you which finding to fix next.

**What you do:** Read the source file, locate the violation, apply the fix (using target_code or fix_plan from the task), verify it compiles, update the task JSON status.

**Confidence routing:**
- **HIGH + MEDIUM** findings: fix them as instructed, no human approval needed
- **LOW** findings: the pipeline presents these for human review after all HIGH+MEDIUM in the phase are done. The human decides: fix, skip, or skip-all for that rule. Decisions persist in `docs/audit/data/human-decisions.json` and are not re-asked.

**Budget check:** Before each dispatch, the pipeline verifies token budget. If remaining budget < 30,000 tokens, it auto-pauses with resume instructions.

**Revalidation:** After each phase completes, remaining tasks are revalidated against live source code. Findings that were fixed collaterally (by fixing a related issue) are automatically marked resolved. Zero tokens spent.

**Commit convention:** `fix(phase-N): [phase-name] - X applied`

### SHARINGAN_PHASE_N (Verification)

**What happens:** Pipeline emits detailed sharingan instructions for the just-completed phase, including exact commands for all 6 gates.

**What you do:** Run each gate in order. The pipeline output tells you exactly what to run:

**Gate 0 -- Deterministic Build (bash, unfakeable):**
```bash
bash $SHARINGAN_DIR/gates/verify-deterministic.sh $BASE_COMMIT
```
Type-check, lint, stub detection, unsafe type detection. No LLM involved.

**Gate 1 -- Spec Compliance (evidence-based):**
For each task in the phase task file, verify the fix is present with file:line evidence and SHA-256 hash.

**Gate 2 -- Code Correctness (LLM + tool calls):**
Check SSOT, security, typing, business logic on files modified since the base commit. Every check requires a Read/Grep tool call as evidence.

**Gate 3 -- Independent Verification (fresh-context sub-agent):**
```bash
bash $SHARINGAN_DIR/gates/verify-independent.sh --plan $TASK_FILE --base $BASE_COMMIT
```
A separate agent with zero builder context rates each requirement. MUST use a different model or engine from the builder.

**Gate 4 -- Runtime Verification (if UI/API changes):**
Start dev server, verify pages load and endpoints respond using Playwright/curl.

**Gate 5 -- Reconciliation (deterministic, no LLM):**
```bash
bash $SHARINGAN_DIR/gates/reconcile.sh $BASE_COMMIT
```
Cross-references all gate results. Writes CLEAR or BLOCKED verdict.

**CLEAR verdict:** Phase is marked verified. Run the pipeline script again to advance to the next phase.
**BLOCKED verdict:** Fix the issues found, then run the pipeline script again. Sharingan re-runs.

**Interactive mode:** After a phase is verified (CLEAR), the pipeline pauses for approval before continuing to the next phase. The human can stop, switch to auto mode, or proceed.

### PIPELINE_COMPLETE

**What happens:** All phases fixed and verified. Pipeline prints a summary:
- Total findings detected
- Phases verified (all CLEAR)
- Sessions used
- Pipeline ID

**Cleanup:** Sentinel file (`.dojutsu-active`) is cleared. Progress narrative receives a final entry. Git tags are preserved for auditability.

---

## Session Resilience

### How Resume Works

1. Pipeline reads last entry in `dojutsu-progress.jsonl`
2. If `exit_reason` is `rate_limited`, `context_exhaustion`, or `manual_pause`:
   - Increments `session_count` in state
   - Clears `dispatch-log.jsonl` (fresh token budget for new session)
   - Prints resume header with previous session's pause reason
3. Detects current stage from disk artifacts (not from saved stage field)
4. Continues from the detected stage

### Graceful Exit Checklist (when approaching context limit)

1. Let the current eye finish its current action
2. Run `--status` to verify the saved state
3. End the session
4. Start a new session and run `/dojutsu` -- it resumes exactly where it left off

### What NOT to Do on Resume

- Never reconstruct state from memory of a previous session
- Never re-run completed stages manually
- Never skip `--resume` when continuing a paused run (though the pipeline auto-detects resume conditions)

---

## Error Handling

### Failure Counting

Each eye has an independent failure counter in `state.failure_counts`. Reset to 0 on success.

### Retry Policy

- **0-1 failures:** Retry normally
- **2 failures (MAX_FAILURES_PER_EYE):** Warning printed. Consider model escalation (use a more capable tier).
- **4 failures (MAX_FAILURES_PER_EYE + MAX_ESCALATED_FAILURES):** BLOCKED. Human review required. Pipeline prints last error.

### Rate Limit Detection

The pipeline checks combined stdout+stderr for these keywords: `rate limit`, `limit exceeded`, `too many requests`, `429`, `quota`, `hit your limit`, `resets`. If detected, the pipeline auto-pauses (does not count as a failure).

### HMAC Mismatch

Means `dojutsu-state.json` was modified outside the pipeline. Delete the state file and restart. The progress narrative is preserved (append-only, separate file).

### Missing Skills

Pre-flight checks verify all 4 sibling skills (rinnegan, byakugan, rasengan, sharingan) are resolvable. If any are missing, the pipeline prints install instructions and exits.

### Stale Sentinel

If the sentinel PID is dead, the pipeline auto-cleans the sentinel on next run. If it persists, delete `docs/audit/data/.dojutsu-active` manually.

---

## Dispatch Mode Reference

### Native Mode

Pipeline prints `DISPATCH_MODE: native`. ACTION instructions include `MODEL: <tier>` hints. Use your agent's own model selection mechanism (e.g., Claude's `model` parameter for subagents).

### Agent-Mux Mode

Pipeline prints `DISPATCH_MODE: agent-mux`. ACTION instructions include `ROLE: <role>`. Pipe requests to agent-mux:
```bash
printf '{"role":"<ROLE>","prompt":"...","cwd":"/path/to/project"}' | agent-mux --stdin
```

### Verifier Independence

The verifier (sharingan Gate 3) MUST use a different engine or model from the builder. In native mode, the pipeline specifies a different model tier. In agent-mux mode, the verifier role routes to a different engine automatically.

---

## Anti-Sycophancy Rules

1. **Do not skip stages.** A finding that "looks fine" still needs detection, analysis, remediation, and verification. No shortcuts.

2. **Do not override confidence routing.** If the pipeline says LOW confidence requires human review, present it to the human. Do not auto-fix it to save time.

3. **Do not claim PIPELINE_COMPLETE early.** The pipeline determines completion from disk artifacts, not from agent claims. Only the pipeline can print PIPELINE_COMPLETE.

4. **Budget is a feature, not a bug.** Auto-pause protects the user's wallet. Never circumvent budget checks or pretend remaining budget is sufficient.

5. **Disk state is truth.** If your memory of the pipeline state disagrees with what `--status` shows, trust `--status`.

---

## Resume Rules (Quick Reference)

1. ALWAYS run the pipeline script first.
2. NEVER write inline scripts to generate artifacts.
3. NEVER continue from memory of a previous session.
4. The pipeline script is the ONLY authority.
