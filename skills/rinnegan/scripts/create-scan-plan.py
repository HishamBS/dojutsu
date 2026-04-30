#!/usr/bin/env python3
"""Usage: create-scan-plan.py <audit_dir>
Creates scan-plan.json with one batch per batch_size source files (from dojutsu.toml)."""
import json, math, os, sys


def build_plan(audit_dir: str) -> dict:
    """Read inventory.json, filter, batch files into a scan plan, write scan-plan.json."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from dojutsu_config import DojutsuConfig

    _cfg = DojutsuConfig()
    inv = json.load(open(f"{audit_dir}/data/inventory.json"))
    SKIP_TAGS = ("OVERSIZED", "GENERATED")

    files = [
        f["path"] for f in inv["files"]
        if f.get("tag", "SOURCE") not in SKIP_TAGS
        and not f.get("nominal", False)
        and not f.get("is_meta_file", False)
    ]
    path_to_layer = {f["path"]: f.get("layer", "mixed") for f in inv["files"]}

    avg_loc = inv["total_loc"] // max(len(files), 1) if files else 0
    batch_size = _cfg.max_batch_for("scanner", avg_loc=avg_loc)
    batches = []
    for i in range(math.ceil(len(files) / batch_size) if files else 0):
        batch_files = files[i * batch_size:(i + 1) * batch_size]
        layer = path_to_layer.get(batch_files[0], "mixed") if batch_files else "mixed"
        batches.append({
            "id": i + 1, "layer": layer, "files": batch_files, "status": "pending",
            "output_file": f"data/scanner-output/scanner-{i + 1}-{layer}.jsonl", "finding_count": 0
        })

    plan = {"total_batches": len(batches), "completed": 0, "batches": batches}
    with open(f"{audit_dir}/data/scan-plan.json", "w") as f:
        json.dump(plan, f, indent=2)
    return plan


if __name__ == "__main__":
    audit_dir = sys.argv[1]
    plan = build_plan(audit_dir)
    inv = json.load(open(f"{audit_dir}/data/inventory.json"))
    SKIP_TAGS = ("OVERSIZED", "GENERATED")
    all_files = [
        f["path"] for f in inv["files"]
        if f.get("tag", "SOURCE") not in SKIP_TAGS
    ]
    batched_count = sum(len(b["files"]) for b in plan["batches"])
    skipped = sum(1 for f in inv["files"] if f.get("tag", "SOURCE") in SKIP_TAGS)
    print(f"Created scan plan: {plan['total_batches']} batches for {batched_count} files (skipped {skipped} {'/'.join(SKIP_TAGS)})")
