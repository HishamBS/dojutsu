#!/usr/bin/env bash
RINNEGAN="$(cd "$(dirname "$0")" && pwd)"
RASENGAN="$(dirname "$RINNEGAN")/rasengan"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

echo "============================================"
echo "  NARUTO TRIO PREFLIGHT v5 (Four-Part)"
echo "============================================"
echo ""

echo "=== 1. SKILL.MD SIZE ==="
RL=$(wc -l < "$RINNEGAN/SKILL.md")
AL=$(wc -l < "$RASENGAN/SKILL.md")
[[ "$RL" -le 100 ]] && pass "rinnegan $RL lines (<= 100)" || fail "rinnegan $RL lines (> 100)"
[[ "$AL" -le 100 ]] && pass "rasengan $AL lines (<= 100)" || fail "rasengan $AL lines (> 100)"
echo ""

echo "=== 2. REFERENCE FILES ==="
for f in scanner-prompt.md scripts/aggregate_findings.ts finding-schema.md output-templates.md rules-reference.md fix-enricher-instructions.md; do
  [[ -f "$RINNEGAN/$f" ]] && pass "$f" || fail "$f MISSING"; done
for f in engineering-rules-checklist.md report-generator-prompt.md; do
  [[ -f "$RASENGAN/$f" ]] && pass "rasengan/$f" || fail "rasengan/$f MISSING"; done
echo ""

echo "=== 3. SCRIPTS ==="
for f in scripts/create-scan-plan.ts scripts/merge-enriched.ts scripts/check-scan-progress.ts; do
  [[ -f "$RINNEGAN/$f" ]] && pass "$f" || fail "$f MISSING"; done
for f in verify-output.sh verify-snippets.sh verify-coverage.sh; do
  bash -n "$RINNEGAN/$f" 2>/dev/null && pass "$f syntax" || fail "$f syntax ERR"; done
for f in verify-phase.sh verify-fix-compliance.sh track-progress.sh generate-commit-message.sh; do
  bash -n "$RASENGAN/$f" 2>/dev/null && pass "$f syntax" || fail "$f syntax ERR"; done
echo ""

echo "=== 4. SKILL.MD CONTENT ==="
grep -q "scan plan" "$RINNEGAN/SKILL.md" && pass "rinnegan: scan plan" || fail "no scan plan"
grep -q "fix-enricher" "$RINNEGAN/SKILL.md" && pass "rinnegan: fix-enricher" || fail "no fix-enricher"
grep -q "scanner-prompt.md" "$RINNEGAN/SKILL.md" && pass "rinnegan: scanner ref" || fail "no scanner ref"
grep -q "aggregate_findings" "$RINNEGAN/SKILL.md" && pass "rinnegan: aggregator ref" || fail "no aggregator ref"
grep -q "verify-fix-compliance" "$RASENGAN/SKILL.md" && pass "rasengan: compliance ref" || fail "no compliance"
grep -q "human-decisions.json" "$RASENGAN/SKILL.md" && pass "rasengan: state tracking" || fail "no state"
grep -q "report-generator-prompt" "$RASENGAN/SKILL.md" && pass "rasengan: report ref" || fail "no report ref"
echo ""

echo "=== 5. NO OLD PATTERNS ==="
grep -q "orchestrator-prompt" "$RINNEGAN/SKILL.md" && fail "still refs orchestrator-prompt" || pass "no orchestrator-prompt"
grep -q "task-executor-prompt" "$RASENGAN/SKILL.md" && fail "still refs task-executor" || pass "no task-executor"
grep -q "stale-fix-adapter" "$RASENGAN/SKILL.md" && fail "still refs stale-fix" || pass "no stale-fix"
grep -q "Anti-Shortcut\|IRON LAW\|NON-NEGOTIABLE\|HARD CONSTRAINTS" "$RINNEGAN/SKILL.md" && fail "rinnegan has old noise sections" || pass "rinnegan clean process"
echo ""

echo "============================================"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "============================================"
[[ "$FAIL" -eq 0 ]] && echo "  ALL CLEAR" && exit 0 || echo "  BLOCKED — $FAIL issues" && exit 1
