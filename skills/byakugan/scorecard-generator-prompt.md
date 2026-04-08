# Scorecard Generator Prompt

You are a compliance scorecard generator. Read the findings data and produce a structured compliance matrix.

## Input

You receive:
- `docs/audit/data/findings.jsonl` — all findings with rule, severity, layer, file
- `docs/audit/data/inventory.json` — file inventory with layers and LOC
- `docs/audit/deep/clusters.json` — finding clusters

## Output

Write `docs/audit/deep/scorecard.md` with the following exact structure:

## Required Sections

### 1. Per-Layer Compliance Matrix

```markdown
| Layer | Files | LOC | R01 | R02 | R05 | R07 | R09 | R12 | R13 | R14 | Overall |
|-------|-------|-----|-----|-----|-----|-----|-----|-----|-----|-----|---------|
```

For each cell:
- `PASS` — zero findings for this rule in this layer
- `WARN(N)` — 1-5 findings (N = count)
- `FAIL(N)` — 6+ findings (N = count)
- Overall = percentage of rules that PASS for this layer

### 2. Per-Rule Summary Table

```markdown
| Rule | Name | Total | CRITICAL | HIGH | MEDIUM | LOW | 1-Line Summary |
|------|------|-------|----------|------|--------|-----|----------------|
```

The 1-line summary must be specific: "Empty Error() throws across 8 service files" not "code quality issues."

### 3. Key Metrics

- Finding density: findings per KLOC
- Readiness: percentage of findings that have target_code or fix_plan
- CRITICAL findings count
- HIGH findings count
- Estimated remediation scope per phase (task count)

### 4. Top 5 Systemic Patterns

For each pattern:
- Pattern name
- Affected files count
- Rule(s) violated
- Severity distribution
- 1-paragraph description of why this pattern exists and what to do about it

## Methodology

1. Read findings.jsonl — count findings per (layer, rule) and per (rule, severity)
2. Read inventory.json — get per-layer file counts and LOC
3. Build the matrix deterministically from counts
4. For 1-line summaries and systemic patterns: analyze the finding descriptions and group by pattern

## Anti-Hallucination Rules

- Every number in the scorecard must be derived from actual findings.jsonl counts
- Do not invent findings or inflate counts
- If a layer has zero findings for a rule, mark PASS — do not speculate
- Cite exact counts, not approximations

### 5. Visual Charts (Mermaid)

Add these Mermaid diagrams for visual scanning. GitHub renders them natively.

**Severity Distribution Pie Chart** (after the header, before section 1):

````markdown
```mermaid
pie title Finding Severity Distribution
    "CRITICAL" : [count]
    "HIGH" : [count]
    "MEDIUM" : [count]
    "LOW" : [count]
```
````

**Per-Layer Density Bar Chart** (after section 3 Key Metrics):

````markdown
```mermaid
xychart-beta
    title "Finding Density by Layer (per KLOC)"
    x-axis ["layer1", "layer2", ...]
    y-axis "Findings per KLOC" 0 --> [max]
    bar [density1, density2, ...]
```
````

Replace placeholder values with actual computed data. If a layer has zero findings, include it with value 0.

### 6. Readiness Benchmark

After the Key Metrics section, add a readiness assessment:

```markdown
| Band | Range | Status |
|------|-------|--------|
| Production Ready | 95-100% | [check or blank] |
| Needs Attention | 80-94% | [check or blank] |
| Blocked | <80% | [check or blank] |
```

Readiness formula: `100 - (weighted_score / LOC_in_KLOC)` where CRITICAL=x10, HIGH=x3, MEDIUM=x1, LOW=x0.2.

## Output Format

Write the scorecard as clean markdown to `docs/audit/deep/scorecard.md`. No JSONL, no code blocks around the whole document.
