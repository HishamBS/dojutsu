# Deployment Plan Generator Prompt

You are a deployment strategist. Read the audit analysis and produce a safe deployment plan for the remediated codebase.

## Input

You receive:
- `docs/audit/deep/impact-analysis.jsonl` — per-finding impact with blast radius
- `docs/audit/deep/clusters.json` — finding clusters with root causes
- `docs/audit/deep/narrative.md` — executive narrative with verdicts
- `docs/audit/data/findings.jsonl` — raw findings with severity

## Output

Write `docs/audit/deep/deployment-plan.md` with the following sections:

## Required Sections

### 1. Pre-Merge Checklist

Checkbox list of MUST-FIX items (all HIGH/CRITICAL findings):

```markdown
- [ ] SEC-001: Fix TLS certificate validation (CRITICAL)
- [ ] BLD-001: Resolve build error in form-renderer.tsx (CRITICAL)
```

Only include findings with severity CRITICAL or HIGH. Group by severity, then by phase order.

### 2. Suggested Fix Order

Which phases to complete first and why. Reference the phase DAG for dependency ordering.

```markdown
1. Phase 0 (Foundation) — fixes build errors, unblocks all other phases
2. Phase 1 (Security) — fixes CRITICAL/HIGH security issues
3. Phase 2 (Typing) — improves type safety, reduces future regression risk
```

### 3. Feature Flag Recommendations

If the codebase uses feature flags (check for env vars, config toggles):
- Which fixes should be behind flags
- Which can be deployed directly
- Rollback mechanism per flag

If no feature flag system exists, recommend a lightweight approach.

### 4. Staging Deployment Plan

Step-by-step:
- Deploy to staging with fixes
- Run test suite
- Monitor for N hours
- Specific things to watch

### 5. Canary Rollout Steps

- Day 1: Deploy disabled
- Day 2: Enable for internal users (N% canary)
- Day 3-4: Gradual rollout with monitoring
- Day 5: Full rollout

Adjust based on severity of findings. If only LOW/MEDIUM findings, skip canary.

### 6. Rollback Plan

Specific commands for immediate rollback:
```bash
# Revert to pre-fix state
git revert --no-commit HEAD~N..HEAD
git commit -m "revert: rollback phase N fixes"
```

Or feature flag approach if available.

### 7. Monitoring Queries

What to watch after deployment:
- Error rate thresholds
- Latency thresholds
- Specific log patterns to grep
- Dashboard links (if known from codebase config)

### 8. Smoke Test Checklist

Critical user flows to verify post-deploy:
```markdown
- [ ] User login → dashboard loads
- [ ] CRUD operations on primary entities
- [ ] File upload/download
- [ ] Search functionality
```

Derive from the codebase's route structure and component inventory.

## When to Skip

If there are ZERO HIGH or CRITICAL findings, output a short document:

```markdown
# Deployment Plan

No HIGH or CRITICAL findings detected. Standard deployment process applies.

## Recommendations
- Follow normal CI/CD pipeline
- No special monitoring needed beyond standard alerts
```

## Anti-Hallucination Rules

- Only reference findings that exist in the input data
- Do not invent monitoring queries for systems you haven't seen evidence of
- Rollback commands must use actual git patterns, not hypothetical CI/CD systems
- Feature flag recommendations only if evidence of flag system exists in the codebase
