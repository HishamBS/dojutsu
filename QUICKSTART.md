# Quickstart

The dojutsu pipeline runs all 4 eyes autonomously. One command does everything. Individual eyes can also be run standalone.

## Recipe 0: Full Pipeline (Recommended)

```
cd your-project
/dojutsu
```

Runs: rinnegan (detect) -> byakugan (analyze) -> rasengan (fix, per phase) -> sharingan (verify, per phase) -> COMPLETE.
Session-resilient: if your session ends, run `/dojutsu` again to resume.

## Individual Eyes

Each skill also runs autonomously on its own -- invoke it and let it work.

## Recipe 1: Audit a Codebase

Open Claude Code in your project directory and type:

```
/rinnegan
```

**What happens:**
1. Inventory creation -- catalogs all source files, detects stack and framework (~2 seconds)
2. Grep scanner -- finds mechanical violations exhaustively (~5 seconds)
3. LLM scanners -- dispatches agents to scan files by layer, finding deeper issues (~10-30 minutes depending on codebase size)
4. Aggregation -- merges all findings into a single `findings.jsonl`
5. Enrichment -- adds fix instructions (`target_code` or `fix_plan`) to each finding
6. Phase generation -- creates ordered task files for remediation
7. Documentation -- generates layer docs, master audit hub, cross-cutting analysis

**Output:** `docs/audit/` directory with everything needed for remediation.

**When it's done:** The pipeline script prints `PIPELINE_COMPLETE`.

## Recipe 2: Fix Audit Findings

After rinnegan completes, type:

```
/rasengan
```

**What happens:**
1. Reads the phase-ordered task files from `docs/audit/data/tasks/`
2. For each task: reads the source file, applies the fix, verifies the build
3. After each fix: updates the task JSON with `completed_at` timestamp
4. After each phase: commits with message `fix(phase-N): [name] - X applied`
5. Updates `progress.md` with phase completion status

**Build safety:** After every fix, rasengan runs `tsc --noEmit` (or equivalent for your stack). If the build breaks, it stops and reports the error before moving on.

**When it's done:** The pipeline prints `ALL_PHASES_COMPLETE`.

## Recipe 3: Verify Changes

After rasengan completes (or after any code changes), type:

```
/sharingan
```

**What happens:**
- Gate 0: Type-check, lint, stub detection (deterministic, unfakeable)
- Gate 1: Spec compliance with file:line evidence
- Gate 2: Code correctness checks (SSOT, security, typing)
- Gate 3: Independent verification by a fresh-context agent
- Gate 4: Runtime checks (if applicable)
- Gate 5: Reconciliation and HMAC-signed verdict

**Output:** CLEAR (all gates pass) or BLOCKED (with specific failures to fix).

## Full Pipeline

For a complete audit-fix-verify cycle:

```
/rinnegan          # Audit the codebase
/rasengan          # Fix findings phase by phase
/sharingan         # Verify everything is clean
```

Each command runs autonomously. You can walk away and check back when each completes.

## Tips

- **Large codebases (>100K LOC):** Rinnegan scanning may dispatch many parallel agents. This is normal.
- **Build failures during rasengan:** The pipeline stops and reports which fix broke the build. Fix it manually or skip the task.
- **Partial runs:** Both rinnegan and rasengan save state to disk. If interrupted, re-invoke the same command -- it picks up where it left off.
- **Multiple projects:** Each project gets its own `docs/audit/` directory. The skills are stateless between projects.
