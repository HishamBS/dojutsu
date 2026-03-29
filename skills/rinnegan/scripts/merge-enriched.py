#!/usr/bin/env python3
"""Usage: merge-enriched.py <audit_dir>
Merges enriched findings back into findings.jsonl with safety checks."""
import json, glob, shutil, sys

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
        out.write(json.dumps(finding) + "\n")
original_count = sum(1 for _ in open(f"{original}.bak"))
enriched_count = len(all_findings)
print(f"Merged: {enriched_count} findings (was {original_count})")
if enriched_count < original_count:
    print(f"WARNING: Lost {original_count - enriched_count} findings! Restoring backup.")
    shutil.copy2(f"{original}.bak", original)
    sys.exit(1)
