#!/usr/bin/env bash
# Sharingan Gate 5: Reconciliation
# Agent-agnostic — cross-references all verification sources
#
# Usage: reconcile.sh [SHARINGAN_BASE]
# Reads: evidence file, independent review, runtime check, deterministic results
# Output: verdict-{PROJECT_HASH}.json
#
# NO LLM judgment. Pure data comparison.

set -euo pipefail

SHARINGAN_BASE="${1:-HEAD~1}"
CACHE_DIR="${SHARINGAN_CACHE_DIR:-$HOME/.cache/sharingan}"
PROJECT_HASH=$(echo -n "$PWD" | shasum -a 256 | cut -c1-16)
EVIDENCE_DIR="${CACHE_DIR}/evidence-${PROJECT_HASH}"
EVIDENCE_FILE="${CACHE_DIR}/evidence-${PROJECT_HASH}.jsonl"
REVIEW_FILE="${CACHE_DIR}/independent-review-${PROJECT_HASH}.json"
RUNTIME_FILE="${CACHE_DIR}/runtime-check-${PROJECT_HASH}.json"
VERDICT_FILE="${CACHE_DIR}/verdict-${PROJECT_HASH}.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Gate 5: Reconciliation"
echo "Cross-referencing all verification sources..."
echo ""

# ── Step 1: Final deterministic check ──
echo "Step 1: Running final deterministic verification..."
DETERM_EXIT=0
bash "$SCRIPT_DIR/verify-deterministic.sh" "$SHARINGAN_BASE" > /dev/null 2>&1 || DETERM_EXIT=$?
if [[ $DETERM_EXIT -ne 0 ]]; then
  echo "  FAIL: Final deterministic check found $DETERM_EXIT failures"
  echo "  Fixes may have introduced regressions."
fi

# ── Step 2: Cross-reference sources ──
echo "Step 2: Cross-referencing evidence, review, and runtime..."

# Export variables so the Python heredoc can access them via os.environ
export CACHE_DIR PROJECT_HASH EVIDENCE_FILE REVIEW_FILE RUNTIME_FILE VERDICT_FILE DETERM_EXIT SHARINGAN_BASE SCRIPT_DIR

python3 << 'PYEOF'
import json, os, sys, hashlib
import hmac as hmac_mod
from pathlib import Path
from datetime import datetime, timezone

cache_dir = os.environ.get('CACHE_DIR', os.path.expanduser('~/.cache/sharingan'))
project_hash = os.environ.get('PROJECT_HASH', 'default')
evidence_file = os.environ.get('EVIDENCE_FILE', '')
review_file = os.environ.get('REVIEW_FILE', '')
runtime_file = os.environ.get('RUNTIME_FILE', '')
verdict_file = os.environ.get('VERDICT_FILE', '')
determ_exit = int(os.environ.get('DETERM_EXIT', '0'))
sharingan_base = os.environ.get('SHARINGAN_BASE', 'HEAD~1')

# Load evidence (builder claims)
builder_claims = {}
if os.path.exists(evidence_file):
    with open(evidence_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                req_id = entry.get('req_id', '')
                if req_id:
                    builder_claims[req_id] = entry
            except json.JSONDecodeError:
                continue

# Load independent review
verifier_ratings = {}
verifier_summary = {}
verifier_completed = False
verifier_engine = "unknown"
verifier_model = "unknown"
if os.path.exists(review_file):
    try:
        with open(review_file) as f:
            review = json.load(f)
        verifier_completed = True
        verifier_summary = review.get('summary', {})
        dispatch = review.get('dispatch', {})
        verifier_engine = dispatch.get('engine', 'unknown')
        verifier_model = dispatch.get('model', 'unknown')
        for req in review.get('requirements', []):
            req_id = req.get('req_id', '')
            if req_id:
                verifier_ratings[req_id] = req
    except (json.JSONDecodeError, KeyError):
        pass

# Load runtime check
runtime_results = {}
runtime_failures = 0
if os.path.exists(runtime_file):
    try:
        with open(runtime_file) as f:
            runtime = json.load(f)
        for check in runtime.get('checks', []):
            comp = check.get('component', '')
            if comp:
                runtime_results[comp] = check
            if check.get('status') == 'FAIL':
                runtime_failures += 1
    except (json.JSONDecodeError, KeyError):
        pass

# Reconcile
issues = []
all_reqs = set(list(builder_claims.keys()) + list(verifier_ratings.keys()))

for req_id in sorted(all_reqs):
    builder = builder_claims.get(req_id, {})
    verifier = verifier_ratings.get(req_id, {})

    b_status = builder.get('status', 'NOT_CHECKED')
    v_rating = verifier.get('rating', 'NOT_CHECKED')

    # Disagreement detection
    if b_status == 'VERIFIED' and v_rating in ('SHELL', 'MISSING'):
        issues.append(f"{req_id}: Builder=VERIFIED but Verifier={v_rating} — {verifier.get('evidence', 'no evidence')}")
    elif b_status == 'VERIFIED' and v_rating == 'PARTIAL':
        issues.append(f"{req_id}: Builder=VERIFIED but Verifier=PARTIAL — {verifier.get('evidence', 'no evidence')}")

# Check for blocking conditions
blocked = False
blocked_at = None
remaining = []

if determ_exit > 0:
    blocked = True
    blocked_at = "gate_5_deterministic"
    remaining.append(f"Final deterministic check: {determ_exit} failures")

if not verifier_completed:
    blocked = True
    blocked_at = blocked_at or "gate_3"
    remaining.append("Independent verifier did not complete")

shell_count = verifier_summary.get('shell', 0)
missing_count = verifier_summary.get('missing', 0)
if shell_count > 0 or missing_count > 0:
    blocked = True
    blocked_at = blocked_at or "gate_3"
    remaining.append(f"Verifier found {shell_count} shells, {missing_count} missing")

if runtime_failures > 0:
    blocked = True
    blocked_at = blocked_at or "gate_4"
    remaining.append(f"Runtime: {runtime_failures} failures")

if issues:
    blocked = True
    blocked_at = blocked_at or "gate_5_reconciliation"
    remaining.extend(issues)

if not builder_claims and not verifier_ratings:
    blocked = True
    blocked_at = blocked_at or "gate_5_no_evidence"
    remaining.append("No evidence or independent review found — pipeline was not run")

# Count Gate 1 stats
g1_missing = sum(1 for v in builder_claims.values() if v.get('status') == 'MISSING')
g1_stubs = sum(1 for v in builder_claims.values() if v.get('status') == 'STUB')
g1_verified = sum(1 for v in builder_claims.values() if v.get('status') == 'VERIFIED')

# Write verdict
timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

if blocked:
    verdict = {
        "verdict": "BLOCKED",
        "version": "1.0",
        "timestamp": timestamp,
        "blocked_at": blocked_at,
        "remaining_issues": remaining
    }
    print(f"VERDICT: BLOCKED at {blocked_at}")
    for r in remaining:
        print(f"  - {r}")
else:
    import subprocess
    head_commit = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    verdict = {
        "verdict": "CLEAR",
        "version": "1.0",
        "timestamp": timestamp,
        "head_commit": head_commit,
        "plan": "",
        "scope": "",
        "gates": {
            "gate_0": {"status": "PASS", "hard_failures": 0},
            "gate_1": {
                "status": "PASS",
                "requirements_checked": len(builder_claims),
                "missing": g1_missing,
                "stubs": g1_stubs,
                "verified": g1_verified,
                "iterations": 0
            },
            "gate_2": {"status": "PASS", "checks_run": 9, "failures": 0, "iterations": 0},
            "gate_3": {
                "status": "PASS",
                "verifier_completed": True,
                "engine": verifier_engine,
                "model": verifier_model,
                "summary": verifier_summary
            },
            "gate_4": {
                "status": "PASS" if not runtime_file or runtime_failures == 0 else "FAIL",
                "ui_checks": len(runtime_results),
                "api_checks": 0,
                "failures": runtime_failures
            },
            "gate_5": {
                "status": "APPROVED",
                "sources_aligned": len(issues) == 0,
                "final_deterministic": "PASS" if determ_exit == 0 else "FAIL"
            }
        }
    }
    print("VERDICT: CLEAR")
    print(f"  Requirements: {len(builder_claims)} checked, {g1_verified} verified")
    print(f"  Verifier: {verifier_summary}")
    print(f"  Runtime: {len(runtime_results)} checks, {runtime_failures} failures")

with open(verdict_file, 'w') as f:
    json.dump(verdict, f, indent=2)

# ── HMAC Verdict Integrity ──
# Sign the verdict so enforce.sh can detect forgery.
# Key is project-scoped and stable across script updates.
keyfile = Path.home() / ".config" / "spsm" / ".hmac-key"
if keyfile.exists():
    hmac_key = keyfile.read_bytes().strip()
else:
    hmac_key = hashlib.sha256(("sharingan-" + project_hash).encode()).digest()
sign_payload = json.dumps(verdict.get('gates', {}), sort_keys=True) + "|" + verdict.get('timestamp', '')
signature = hmac_mod.new(hmac_key, sign_payload.encode(), hashlib.sha256).hexdigest()
verdict['hmac'] = signature
with open(verdict_file, 'w') as f:
    json.dump(verdict, f, indent=2)
print("  HMAC signature added to verdict.")

print(f"\nVerdict written to: {verdict_file}")
sys.exit(1 if blocked else 0)
PYEOF
