#!/usr/bin/env python3
"""Usage: merge-enriched.py <audit_dir>
Merges enriched findings back into findings.jsonl with safety checks."""
import json, glob, shutil, sys


def assign_confidence_if_missing(f: dict) -> None:
    """Assign confidence deterministically if scanner didn't provide it."""
    if f.get("confidence"):
        return

    rule = f.get("rule", "")
    desc = (f.get("description", "") or "").lower()

    if rule == "R04":
        if any(kw in desc for kw in [".map(", "loop", "n+1", "foreach"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: performance issue in loop/iterator (R04-H1/H3)"
        elif any(kw in desc for kw in ["useeffect", "missing dep", "stale", "infinite"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: useEffect dependency issue (R04-H2)"
        elif any(kw in desc for kw in ["inline", "handler"]) and "prop" in desc:
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: inline value breaks memoization (R04-H4)"
        elif any(kw in desc for kw in ["inline", "handler"]):
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: inline handler (R04-M1)"
        elif any(kw in desc for kw in ["type assertion", "as record", "as unknown"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: unsafe type assertion (R07 cross-rule)"
        elif any(kw in desc for kw in ["duplicate", "regex", "large", "usememo", "usecallback"]):
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: memoization opportunity (R04-M2/M3)"
        elif "react.memo" in desc or "memo" in desc:
            f["confidence"] = "low"
            f["confidence_reason"] = "LOW: general memoization suggestion (R04-L1)"
        else:
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: performance pattern (R04-M3)"
    elif rule == "R11":
        if any(kw in desc for kw in ["hook", "side effect", ">3 param", "complex"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: complex export without JSDoc (R11-H1/H2)"
        elif any(kw in desc for kw in ["component", "prop", "forwardref"]):
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: component without JSDoc (R11-M1)"
        elif any(kw in desc for kw in ["context", "provider"]):
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: provider without JSDoc (R11-M2)"
        else:
            f["confidence"] = "low"
            f["confidence_reason"] = "LOW: simple export without JSDoc (R11-L1)"
    elif rule == "R13":
        if any(kw in desc for kw in ["business", "timeout", "limit", "retry", "threshold"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: business logic constant (R13-H1)"
        elif any(kw in desc for kw in ["duplicate", "appears in", "ssot"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: duplicated constant (R13-H2)"
        elif any(kw in desc for kw in ["url", "port", "endpoint", "localhost"]):
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: hardcoded URL/port (R13-M2)"
        elif any(kw in desc for kw in ["css", "style", "padding", "margin", "gap", "px", "selector"]):
            f["confidence"] = "low"
            f["confidence_reason"] = "LOW: CSS value (R13-L1)"
        else:
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: magic number (R13-M1)"
    elif rule == "R09":
        if any(kw in desc for kw in ["secret", "token", "password", "key"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: potential secret leak (R09-H1)"
        elif "commented" in desc and any(kw in desc for kw in ["block", "dead", ">5"]):
            f["confidence"] = "high"
            f["confidence_reason"] = "HIGH: commented-out code block (R09-H2)"
        elif "console.error" in desc:
            f["confidence"] = "low"
            f["confidence_reason"] = "LOW: console.error in catch (R09-L1)"
        elif "console" in desc:
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: console in production (R09-M1)"
        elif "unicode" in desc or "ternary" in desc:
            f["confidence"] = "low"
            f["confidence_reason"] = "LOW: style preference (R09-L2)"
        else:
            f["confidence"] = "medium"
            f["confidence_reason"] = "MEDIUM: clean code issue (R09-M1)"
    else:
        f["confidence"] = "high"
        f["confidence_reason"] = f"HIGH: {rule} violations are precise"


audit_dir = sys.argv[1]
original = f"{audit_dir}/data/findings.jsonl"
shutil.copy2(original, f"{original}.bak")
enriched_files = sorted(glob.glob(f"{audit_dir}/data/enriched/*.jsonl"))
all_findings = []
for f in enriched_files:
    for line in open(f):
        all_findings.append(json.loads(line.strip()))
with open(original, "w") as out:
    for finding in all_findings:
        assign_confidence_if_missing(finding)
        out.write(json.dumps(finding) + "\n")
original_count = sum(1 for _ in open(f"{original}.bak"))
enriched_count = len(all_findings)
print(f"Merged: {enriched_count} findings (was {original_count})")
if enriched_count < original_count:
    print(f"WARNING: Lost {original_count - enriched_count} findings! Restoring backup.")
    shutil.copy2(f"{original}.bak", original)
    sys.exit(1)
