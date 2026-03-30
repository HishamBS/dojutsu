#!/usr/bin/env python3
"""Usage: create-scan-plan.py <audit_dir>
Creates scan-plan.json with one batch per batch_size source files (from dojutsu.toml)."""
import json, math, os, sys

# Read batch_size from dojutsu.toml via shared config loader
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'dojutsu', 'scripts'))
try:
    from dojutsu_config import get_batch_size
    batch_size = get_batch_size()
except (ImportError, FileNotFoundError):
    batch_size = 30  # sensible default if config not found

audit_dir = sys.argv[1]
inv = json.load(open(f"{audit_dir}/data/inventory.json"))
files = [f["path"] for f in inv["files"] if f.get("tag", "SOURCE") in ("SOURCE", "TEST")]
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
