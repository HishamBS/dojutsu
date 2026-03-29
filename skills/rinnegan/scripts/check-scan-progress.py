#!/usr/bin/env python3
"""Usage: check-scan-progress.py <audit_dir>
Reads scan-plan.json and reports progress."""
import json, sys
plan = json.load(open(f"{sys.argv[1]}/data/scan-plan.json"))
pending = sum(1 for b in plan["batches"] if b["status"] == "pending")
complete = sum(1 for b in plan["batches"] if b["status"] == "complete")
print(f"SCAN_PROGRESS: {complete}/{plan['total_batches']} complete, {pending} pending")
if pending == 0:
    print("ALL_BATCHES_COMPLETE")
else:
    next_pending = [b for b in plan["batches"] if b["status"] == "pending"][:5]
    for b in next_pending:
        print(f"  PENDING: batch {b['id']} layer={b['layer']} output={b['output_file']} file_count={len(b['files'])}")
        print(f"  FILES: {' '.join(b['files'])}")
