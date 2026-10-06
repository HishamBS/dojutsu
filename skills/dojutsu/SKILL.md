---
name: dojutsu
description: Full automated pipeline -- audit, analyze, fix, verify.
  Session-resilient, agent-agnostic, HMAC-signed state machine. Chains rinnegan
  (detect), byakugan (analyze), rasengan (fix), sharingan (verify). Run on any
  project for complete quality remediation.
---

# Dojutsu -- Unified Codebase Quality Pipeline

## Core Principle

The pipeline script is the only authority: all state lives on disk and is HMAC-signed, so only the script advances it.

Dojutsu is a session-resilient, agent-agnostic orchestrator that chains four specialized eyes in strict sequence: rinnegan detects violations, byakugan analyzes dependencies and impact, rasengan fixes findings, sharingan verifies fixes. All state lives on disk with HMAC-signed integrity. Any coding agent (Claude, Codex, OpenCode, Gemini) can run or resume any pipeline at any point.

---

## Operating Rules

1. **Drive it with the script.** Run `bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR`, do the ACTION it prints, and run it again until it prints COMPLETE. Produce artifacts only through the scripts it names (rinnegan's script for a rinnegan step, and so on); the pipeline cannot validate a hand-written substitute.

2. **Re-read state from disk.** Start every session by running the script (or `--status`) instead of continuing from memory of an earlier session; the disk is authoritative.

3. **Leave the state file to the pipeline.** It signs every state change, so a hand edit to `dojutsu-state.json` fails the HMAC check.

4. **Confidence routing.** HIGH and MEDIUM findings are fixed as instructed; LOW findings go to the human for review.

5. **Budget pauses.** When the pipeline pauses on `session_token_budget`, start a new session and run it again (or `--resume`).

6. **Git checkpoints.** The pipeline tags every stage transition (`dojutsu/*`). Those tags are the rollback points, so keep them for the length of the run.

7. **One run at a time.** If `.dojutsu-active` names a live PID, a run is already in progress; wait, or investigate a stale process.

8. **Standalone copy.** A published copy installs its runtime once, with `bun install --frozen-lockfile --production` in its `skills/` directory, and then runs the same commands.

---

## Quick Start

```bash
# Audit only (DEFAULT -- safe, no code changes):
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR

# Audit + fix (interactive -- approve after each phase):
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --fix

# Fix specific phases only:
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --fix --phases 0,1,2

# Fully autonomous (no approval gates):
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --fix --auto

# Resume from saved state:
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --resume

# Show current state (read-only):
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --status

# Show report regeneration instructions:
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --report

# Recursively delete docs/audit/ (only when the operator asks for exactly this):
bun $SKILL_DIR/scripts/run-pipeline.ts $PROJECT_DIR --clean
```

---

## Flags Reference

| Flag | Requires | Description | Default |
|------|----------|-------------|---------|
| *(none)* | | Audit only. Runs rinnegan + byakugan. No code changes. | Yes |
| `--fix` | | Enable code fixing (rasengan + sharingan loop after audit). | |
| `--phases N,M` | `--fix` | Fix only selected phases (0-indexed). The others are not opened and stay pending; a later run can select them. | All phases |
| `--interactive` | `--fix` | Approve after each phase before continuing. | Default with --fix |
| `--auto` | `--fix` | No approval gates. Fully autonomous end-to-end. | |
| `--resume` | | Resume from saved state and flags. Clears exit_reason. | |
| `--status` | | Show pipeline state without advancing. Read-only. | |
| `--report` | | Show report regeneration instructions. | |
| `--clean` | | Recursively delete `docs/audit/`. Run it only on the operator's explicit request (R28). | |

**Mutual exclusivity:** `--status`, `--report`, and `--clean` do not advance the pipeline; `--status` and `--report` are informational, and `--clean` deletes. `--auto` and `--interactive` are mutually exclusive.

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
SHARINGAN_PHASE_0 ─────── Sharingan over the phase range (run.sh --base <phase start>)
    |                         |
    |   BLOCKED ──────────────+──> fix, commit, re-run Sharingan (stays here)
    |   CLEAR / INFRA_* ──────+
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
| RASENGAN_PHASE_N | N is the first phase in `rasengan-state.json` `phases_pending` that `--phases` selects (any pending phase without `--phases`) |
| SHARINGAN_PHASE_N | A phase dojutsu opened (it has a `phase-N-start` checkpoint) is complete in `rasengan-state.json` but not in `verified_phases`. A phase never opened (no tasks, or resolved by revalidation) has no range and is not verified, and neither is one that closed with no commit since it opened (rasengan found nothing left to fix): the pipeline drops its checkpoint and moves on |
| PIPELINE_COMPLETE | No phase `--phases` selects has tasks pending (without `--phases`, `rasengan-state.json` status is `completed`) and every opened phase is verified |

### Delegation Model

Dojutsu does NOT execute eye logic directly. It calls each eye's `run-pipeline.ts` as a subprocess, reads its stdout for ACTION instructions or completion signals, and passes those through to you. The eye scripts are the authority for their domain.

---

## Stage-by-Stage Execution Guide

### RINNEGAN_ACTIVE (Scanning)

**What happens:** Pipeline delegates to rinnegan's `run-pipeline.ts`. Rinnegan inventories the project, runs grep patterns, dispatches LLM scanners, aggregates findings, enriches with fix instructions, and generates documentation.

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

**What happens:** Pipeline delegates to byakugan's `run-pipeline.ts`. Byakugan builds a dependency graph, clusters findings, and dispatches impact analysis agents. The pipeline then compiles the final deep-analysis docs deterministically.

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

**What happens:** Pipeline delegates to rasengan's `run-pipeline.ts --phase N` for the current phase. Rasengan reads the phase task file and tells you which finding to fix next. It hands out phase N's tasks only: once none are left it prints `PHASE_COMPLETE: N` instead of the next phase's first task, and the next run sends phase N to Sharingan. The next phase opens after Sharingan passes this one.

**What you do:** Read the source file, locate the violation, apply the fix (using target_code or fix_plan from the task), verify it compiles, update the task JSON status.

**Confidence routing:**
- **HIGH + MEDIUM** findings: fix them as instructed, no human approval needed
- **LOW** findings: the pipeline presents these for human review after all HIGH+MEDIUM in the phase are done. The human decides: fix, skip, or skip-all for that rule. Decisions persist in `docs/audit/data/human-decisions.json` and are not re-asked.

**Budget check:** Before each dispatch, the pipeline verifies token budget. If remaining budget < 30,000 tokens, it auto-pauses with resume instructions.

**Revalidation:** After each phase completes, remaining tasks are revalidated against live source code. Findings that were fixed collaterally (by fixing a related issue) are automatically marked resolved. Zero tokens spent.

**Commit convention:** `fix(phase-N): [phase-name] - X applied`

### SHARINGAN_PHASE_N (Verification)

**What happens:** The pipeline prints the Sharingan command for the just-completed phase.

**What you do:** Run the command it prints: the Sharingan entrypoint over the phase's range, `~/.coding-agent/sharingan/run.sh --base <phase-start commit>`. Read the verdict it writes to `.sharingan/<HEAD sha>.verdict.json` in the project root. On `BLOCKED` or `PARTIAL`, fix what the verdict names, commit, and run the pipeline script again. On `CLEAR` or `INFRA_*`, run the pipeline script again.

**How the phase is marked verified:** the pipeline reads that verdict file itself. A verdict for the current HEAD whose `base` is the phase-start commit and whose verdict is `CLEAR` or `INFRA_*` adds the phase to `verified_phases`, and the pipeline advances to the next phase or to PIPELINE_COMPLETE. Any other verdict, or none, keeps the phase here.

**Interactive mode:** After a phase is verified, the pipeline prints the verdict and pauses for approval before continuing to the next phase. The human can stop, switch to auto mode, or proceed.

### PIPELINE_COMPLETE

**What happens:** All phases (with `--phases`, the selected ones) fixed and verified. Pipeline prints a summary:
- Total findings detected
- Phases verified (each by a CLEAR or INFRA_* verdict)
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

### Continuing in a New Session

Each script run saves pipeline state to disk, so a new session resumes by running `/dojutsu` (or the pipeline script); there is nothing to save by hand first.

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

The pipeline checks the eye script's stderr for the rate-limit keywords in `RATE_LIMIT_KEYWORDS` (`scripts/run_pipeline_lib.ts`). If one matches, the pipeline auto-pauses (does not count as a failure).

### HMAC Mismatch

Means `dojutsu-state.json` was modified outside the pipeline. The recovery is to delete the state file and restart: show the operator the path and get their go-ahead before deleting it. The progress narrative is preserved (append-only, separate file).

### Missing Skills

Pre-flight checks verify all 4 sibling skills (rinnegan, byakugan, rasengan, sharingan) are resolvable. If any are missing, the pipeline prints install instructions and exits.

### Stale Sentinel

If the sentinel PID is dead, the pipeline auto-cleans the sentinel on next run. If it persists, ask the operator before deleting `docs/audit/data/.dojutsu-active`.

---

## Dispatch Reference

Pipeline prints `DISPATCH_MODE: native`. ACTION instructions include `MODEL: <tier>` hints. Use your agent's own model selection mechanism (e.g., Claude's `model` parameter for subagents).

---

## Recap

1. **Do not skip stages.** A finding that "looks fine" still needs detection, analysis, remediation, and verification. No shortcuts.

2. **Do not override confidence routing.** If the pipeline says LOW confidence requires human review, present it to the human. Do not auto-fix it to save time.

3. **Disk state is truth.** If your memory of the pipeline state disagrees with what `--status` shows, trust `--status`.
