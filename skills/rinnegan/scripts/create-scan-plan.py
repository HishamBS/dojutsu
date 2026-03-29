#!/usr/bin/env python3
"""Usage: create-scan-plan.py <audit_dir>
Creates scan-plan.json with one batch per 30 source files."""
import json, math, sys

audit_dir = sys.argv[1]
inv = json.load(open(f"{audit_dir}/data/inventory.json"))
files = [f["path"] for f in inv["files"] if f.get("tag", "SOURCE") in ("SOURCE", "TEST")]
batch_size = 120
batches = []
for i in range(math.ceil(len(files) / batch_size)):
    batch_files = files[i*batch_size:(i+1)*batch_size]
    layer = inv["files"][i*batch_size].get("layer", "mixed") if i*batch_size < len(inv["files"]) else "mixed"
    batches.append({
        "id": i+1, "layer": layer, "files": batch_files, "status": "pending",
        "output_file": f"data/scanner-output/scanner-{i+1}-{layer}.jsonl", "finding_count": 0
    })
plan = {"total_batches": len(batches), "completed": 0, "batches": batches}
json.dump(plan, open(f"{audit_dir}/data/scan-plan.json", "w"), indent=2)
print(f"Created scan plan: {len(batches)} batches for {len(files)} files")
