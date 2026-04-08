# Executive Brief Generator

You are generating a 1-page executive brief for stakeholders who do not read code. This is NOT the full narrative — it is a scannable summary designed to be forwarded to VPs and PMs.

## Input

- `docs/audit/data/findings.jsonl` — all findings
- `docs/audit/data/inventory.json` — codebase metrics
- `docs/audit/deep/narrative.md` — full technical narrative (read executive summary section)

## Output

Write to: `docs/audit/deep/executive-brief.md`

## Format

```markdown
# Executive Brief: [Project Name]

**Date:** YYYY-MM-DD | **Stack:** [stack/framework] | **Readiness:** [score]%

---

## Readiness Score

[Mermaid gauge or text indicator with benchmark bands]

| Band | Range | Status |
|------|-------|--------|
| Production Ready | 95-100% | [check or blank] |
| Needs Attention | 80-94% | [check or blank] |
| Blocked | <80% | [check or blank] |

**Current score: [X]%** — [one-sentence interpretation]

---

## Severity Distribution

```mermaid
pie title Finding Severity
    "CRITICAL" : [N]
    "HIGH" : [N]
    "MEDIUM" : [N]
    "LOW" : [N]
```

**Total findings:** [N] across [F] files ([LOC] lines of code)

---

## Top 3 Risks

1. **[Risk name]** — [one-sentence business impact, no code]
2. **[Risk name]** — [one-sentence business impact, no code]
3. **[Risk name]** — [one-sentence business impact, no code]

---

## Remediation Summary

| Phase | Scope | Priority |
|-------|-------|----------|
| [Phase name] | [N] findings | [Must-fix / Should-fix / Nice-to-have] |
| ... | ... | ... |

**Estimated phases:** [N] | **Must-fix findings:** [N]

---

## Recommendation

[2-3 sentences: what should happen next, who needs to act, what the timeline looks like]
```

## Rules

- NO code snippets. NO file paths. NO line numbers. This is for non-technical readers.
- Readiness score: `100 - (weighted_score / LOC_in_KLOC)` where CRITICAL=x10, HIGH=x3, MEDIUM=x1, LOW=x0.2
- Top 3 risks: translate technical findings to business impact ("customer data exposed" not "verify=False")
- Remediation phases: only list phases with findings, ordered by priority
- Mermaid charts: GitHub renders these natively — use them for visual scanning
- Keep under 60 lines total. This is a brief, not a report.
- Tone: authoritative, specific, actionable. No hedging.

## Completion Signal

```
BRIEF_COMPLETE: [WORD_COUNT] words written to [OUTPUT_PATH]
```
