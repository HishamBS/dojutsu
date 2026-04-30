---
name: rinnegan
description: Use when auditing a codebase for engineering rule violations, preparing for production readiness, generating remediation backlogs, or scanning before major milestones.
---

# Rinnegan — Codebase Audit Pipeline

**SCAN EVERY FILE. NO SAMPLING. NO SHORTCUTS.**

## How It Works

1. **Run the pipeline script.** Run: `python3 $SKILL_DIR/scripts/run-pipeline.py $PROJECT_DIR`
   The script auto-creates inventory and scan plan (deterministic, <2 seconds), then tells you exactly what to do next.

2. **Execute the ACTION it outputs.** Scanner and enricher stages still dispatch agents. Final published audit docs are compiled deterministically from SSOT data files; do not hand-author or repair them manually.

3. **Run the script again.** After completing the action, run the same command. The script checks disk state and gives the next action. Repeat until `PIPELINE_COMPLETE`.

## Reference Files (read when the pipeline script tells you to)

| File | Purpose |
|------|---------|
| [scanner-prompt.md](scanner-prompt.md) | Include in scanner Agent dispatches |
| [aggregator-prompt.md](aggregator-prompt.md) | Include in aggregator Agent dispatch |
| [fix-enricher-instructions.md](fix-enricher-instructions.md) | Include in enricher Agent dispatches |
| [finding-schema.md](finding-schema.md) | JSON schemas, phase mapping, task rules |
| [output-templates.md](output-templates.md) | Templates for phase docs, progress, config |

## Publication Contract

- `data/findings.jsonl` is the finding SSOT.
- `data/audit-stats.json` is the aggregate-metrics SSOT.
- `data/quality-gate.json` is the gate-verdict SSOT.
- `master-audit.md`, `layers/*.md`, `cross-cutting.md`, `progress.md`, and `agent-instructions.md` are compiled deterministically from those sources.
- If the rendered docs are wrong, fix the SSOT data or renderer. Do not patch the markdown by hand.

## Phase 1 — cost & noise reduction

All Phase-1 changes are additive with respect to LLM rule scope. No rule is removed from the LLM scanner. The LLM continues to emit findings on every rule it previously emitted on; the deterministic grep scanner now also emits findings on specific *literal* sub-patterns of R12 and R13. The aggregator dedupes by `(file, line, rule)` so different-rule findings at the same line are preserved.

### Behavioral changes

- **Model directive guardrail.** Each ACTION block prints `ENFORCE: pass model: "<short>"`. The orchestrator reads this and chooses to comply; rinnegan does not enforce dispatch-time model selection. Acts as a recorded intent and operator hint.

- **Tightened meta-file allowlist.** Three coincident signals required: (a) directory match (`scripts/ci/`, `scripts/ce/`, etc.), (b) filename match (`enforce-*`, `verify-*`, `*-rule-*`), (c) content marker (`RULE_PATTERNS`, `PatternDef`, or `RULE_DEFS` in first 100 lines). Applied to both grep patterns AND LLM batch assignment. Production files matching only filename prefix (e.g., `packages/auth/src/verify-token.ts`) are NOT allowlisted.

- **`skip_string_literals` flag on PatternDef.** Patterns marked with this flag ignore matches inside source-string literals (single, double, backtick, regex literals). Applied to `@ts-nocheck`, `as any`, and `eslint-disable`. Known limitation: per-line stripping does not handle multi-line template literals on continuation lines (xfail test demonstrates).

- **Density-pressure removal.** All `DENSITY_NOTE` instructions removed from `scanner-prompt.md`. Zero findings on a clean file is correct. "Do not manufacture findings" guidance preserved. Upper-bound noise check (>20 findings/KLOC) preserved.

- **Confidence-gated severity ceiling.** `low → MEDIUM`, `medium → HIGH`, only `high → CRITICAL`. Cap records original severity in `severity_capped_from`. Defense-in-depth, not a fix for grep-emitted CRITICAL false positives (those go through the meta-file allowlist + `skip_string_literals` instead).

- **Additive grep coverage for R12/R13 literal sub-patterns.** New `PatternDef` entries detect: `'0'.repeat(40|64)` placeholder hashes, hardcoded `localhost` URLs (in non-test files via `file_glob_excludes`), `@humain/sdk`/`humain-sdk`/`com.humain.sdk` SDK package names, `.h1-routes.json`/`.h1-manifest.json` manifest filenames. **The LLM scanner is unchanged** — semantic R12/R13 findings continue to flow.

- **`--audit-only` flag.** Skip the enrichment stage when only an audit is needed. Persists via `data/.audit-only` marker file across pipeline re-entries. Saves ~100-200k tokens when used.

- **LOC-based pre-filter (10 LOC default).** Files under threshold tagged `nominal: true` and excluded from LLM scanner batches. Authority allowlist is project-configurable via `<project_dir>/.rinnegan/authority-paths.txt` (newline-separated path prefixes). No hardcoded paths in rinnegan. Deterministic grep still scans nominal files.

- **Aggregator dedup contract.** Updated to dedupe by `(file, line, rule)`. When `(file, line)` matches but `rule` differs, all findings preserved. Different rules at the same line are separate violations.

- **Synthetic recall harness.** `tests/fixtures/synthetic-project/` covers grep-detectable rules with one fixture per rule category. `expected-findings.json` is ground truth. LLM-only rules (R23, R10, A01) documented but not asserted by the harness — covered at acceptance time via per-rule baseline preservation.

### Project-side configuration

Projects can opt into the LOC pre-filter authority allowlist by creating `<project>/.rinnegan/authority-paths.txt` with newline-separated path prefixes (e.g. `packages/shared-constants/`). Files under those prefixes stay LLM-scanned regardless of LOC.
