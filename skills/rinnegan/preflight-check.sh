#!/usr/bin/env bash
RINNEGAN="$(cd "$(dirname "$0")" && pwd)"
RASENGAN="$(dirname "$RINNEGAN")/rasengan"
SHARINGAN="$(dirname "$RINNEGAN")/sharingan"
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
RS=$(grep -c '^[0-9]' "$RINNEGAN/SKILL.md")
AS=$(grep -c '^[0-9]' "$RASENGAN/SKILL.md")
[[ "$RS" -ge 10 ]] && pass "rinnegan $RS numbered steps" || fail "rinnegan only $RS steps"
[[ "$AS" -ge 7 ]] && pass "rasengan $AS numbered steps" || fail "rasengan only $AS steps"
echo ""

echo "=== 2. REFERENCE FILES ==="
for f in scanner-prompt.md aggregator-prompt.md layer-generator-prompt.md master-hub-generator-prompt.md cross-cutting-generator-prompt.md finding-schema.md output-templates.md rules-reference.md fix-enricher-instructions.md validation-instructions.md; do
  [[ -f "$RINNEGAN/$f" ]] && pass "$f" || fail "$f MISSING"; done
for f in engineering-rules-checklist.md report-generator-prompt.md; do
  [[ -f "$RASENGAN/$f" ]] && pass "rasengan/$f" || fail "rasengan/$f MISSING"; done
[[ -f "$SHARINGAN/skill.md" ]] && pass "sharingan/skill.md" || fail "sharingan MISSING"
echo ""

echo "=== 3. SCRIPTS ==="
for f in scripts/create-scan-plan.py scripts/merge-enriched.py scripts/check-scan-progress.py; do
  [[ -x "$RINNEGAN/$f" ]] && pass "$f" || fail "$f MISSING/NOT EXEC"; done
for f in verify-output.sh verify-snippets.sh verify-coverage.sh; do
  bash -n "$RINNEGAN/$f" 2>/dev/null && pass "$f syntax" || fail "$f syntax ERR"; done
for f in verify-phase.sh verify-fix-compliance.sh track-progress.sh generate-commit-message.sh; do
  bash -n "$RASENGAN/$f" 2>/dev/null && pass "$f syntax" || fail "$f syntax ERR"; done
echo ""

echo "=== 4. SKILL.MD CONTENT ==="
grep -q "scan-plan" "$RINNEGAN/SKILL.md" && pass "rinnegan: scan-plan" || fail "no scan-plan"
grep -q "fix-enricher" "$RINNEGAN/SKILL.md" && pass "rinnegan: fix-enricher" || fail "no fix-enricher"
grep -q "scanner-prompt.md" "$RINNEGAN/SKILL.md" && pass "rinnegan: scanner ref" || fail "no scanner ref"
grep -q "aggregator-prompt.md" "$RINNEGAN/SKILL.md" && pass "rinnegan: aggregator ref" || fail "no aggregator ref"
grep -q "SCAN EVERY FILE" "$RINNEGAN/SKILL.md" && pass "rinnegan: Iron Law" || fail "no Iron Law"
grep -q "verify-fix-compliance" "$RASENGAN/SKILL.md" && pass "rasengan: compliance ref" || fail "no compliance"
grep -q "rasengan-results.json\|rasengan-state" "$RASENGAN/SKILL.md" && pass "rasengan: state tracking" || fail "no state"
grep -q "report-generator-prompt" "$RASENGAN/SKILL.md" && pass "rasengan: report ref" || fail "no report ref"
echo ""

echo "=== 5. NO OLD PATTERNS ==="
grep -q "orchestrator-prompt" "$RINNEGAN/SKILL.md" && fail "still refs orchestrator-prompt" || pass "no orchestrator-prompt"
grep -q "task-executor-prompt" "$RASENGAN/SKILL.md" && fail "still refs task-executor" || pass "no task-executor"
grep -q "stale-fix-adapter" "$RASENGAN/SKILL.md" && fail "still refs stale-fix" || pass "no stale-fix"
grep -q "Anti-Shortcut\|IRON LAW\|NON-NEGOTIABLE\|HARD CONSTRAINTS" "$RINNEGAN/SKILL.md" | grep -v "SCAN EVERY" > /dev/null 2>&1 && fail "rinnegan has old noise sections" || pass "rinnegan clean process"
echo ""

echo "============================================"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "============================================"
[[ "$FAIL" -eq 0 ]] && echo "  ALL CLEAR" && exit 0 || echo "  BLOCKED — $FAIL issues" && exit 1
