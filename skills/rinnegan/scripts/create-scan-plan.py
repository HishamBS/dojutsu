#!/usr/bin/env python3
"""Usage: create-scan-plan.py <audit_dir>
Creates scan-plan.json with one batch per batch_size source files (from dojutsu.toml)."""
import json, math, os, sys

# Read pipeline config from dojutsu.toml via shared config loader
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dojutsu_config import DojutsuConfig

_cfg = DojutsuConfig()

audit_dir = sys.argv[1]
inv = json.load(open(f"{audit_dir}/data/inventory.json"))
SKIP_TAGS = ("OVERSIZED", "GENERATED")
files = [
    f["path"] for f in inv["files"]
    if f.get("tag", "SOURCE") not in SKIP_TAGS
]
avg_loc = inv["total_loc"] // max(len(files), 1)
batch_size = _cfg.max_batch_for("scanner", avg_loc=avg_loc)
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
skipped = sum(1 for f in inv["files"] if f.get("tag", "SOURCE") in SKIP_TAGS)
print(f"Created scan plan: {len(batches)} batches for {len(files)} files (skipped {skipped} {'/'.join(SKIP_TAGS)})")
