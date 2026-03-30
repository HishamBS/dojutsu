---
name: rasengan
description: Use when fixing audit findings from a rinnegan scan, remediating engineering rule violations, or autonomously resolving a codebase audit backlog.
---

# Rasengan -- Autonomous Audit Remediation

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script finds the current phase, next pending task, and tells you exactly what to fix.

2. **Execute the ACTION it outputs.** Read the source file, locate the violation, apply the fix (target_code or fix_plan), verify it's present, update the task JSON status.

3. **Run the script again.** It gives you the next task. Repeat until `ALL_PHASES_COMPLETE`. Commit after each phase: `fix(phase-N): [name] - X applied`.

4. **LOW-confidence review.** After HIGH+MEDIUM findings are auto-fixed in a phase, the script presents any LOW-confidence findings for human review. The human decides: fix, skip, or skip-all for a rule. Decisions persist in `docs/audit/data/human-decisions.json` and are not re-asked on subsequent runs.

5. **After ALL_PHASES_COMPLETE:** Run `/sharingan` to verify the full codebase builds clean and passes quality gates. This is mandatory per CLAUDE.md before claiming completion.

## Reference Files (read when needed)

| File | Purpose |
|------|---------|
| [engineering-rules-checklist.md](engineering-rules-checklist.md) | Grep patterns for self-checking fixes |
| [report-generator-prompt.md](report-generator-prompt.md) | Final summary report structure |
| verify-phase.sh | Phase verification (run after each phase) |
| verify-fix-compliance.sh | Single-file compliance check |
