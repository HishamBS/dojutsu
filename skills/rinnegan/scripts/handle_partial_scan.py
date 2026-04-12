"""Handle SCAN_PARTIAL recovery -- create follow-up batches for incomplete scans."""
from __future__ import annotations

import json
import sys


def recover_partial_batch(
    plan_path: str,
    batch_id: int,
    scanned_files: list[str],
) -> None:
    """Update scan-plan.json after a partial scan.

    If the scanner completed some but not all files, marks the batch as
    'partial' and creates a new batch with the remaining files.
    If all files were scanned, marks as 'complete'.
    If no files were scanned, marks as 'pending' and increments retry count.
    """
    with open(plan_path) as fh:
        plan = json.load(fh)

    # Find the batch with matching batch_id
    target = None
    for batch in plan["batches"]:
        if batch["id"] == batch_id:
            target = batch
            break

    if target is None:
        raise ValueError(f"Batch {batch_id} not found in {plan_path}")

    scanned_set = set(scanned_files)
    remaining = [f for f in target["files"] if f not in scanned_set]

    if not scanned_files:
        # No files scanned -- mark pending, increment retries for circuit breaker
        target["status"] = "pending"
        target["retries"] = target.get("retries", 0) + 1
    elif not remaining:
        # All files scanned -- mark complete
        target["status"] = "complete"
    else:
        # Partial scan -- mark batch partial, create follow-up batch
        target["status"] = "partial"

        max_id = max(b["id"] for b in plan["batches"])
        new_batch = {
            "id": max_id + 1,
            "layer": target["layer"],
            "files": remaining,
            "status": "pending",
            "output_file": f"data/scanner-output/scanner-{max_id + 1}-{target['layer']}.jsonl",
            "finding_count": 0,
            "parent_batch": batch_id,
        }
        plan["batches"].append(new_batch)
        plan["total_batches"] = len(plan["batches"])

    with open(plan_path, "w") as fh:
        json.dump(plan, fh, indent=2)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: handle_partial_scan.py <plan_path> <batch_id> <comma-separated-scanned-files>")
        sys.exit(1)
    plan_path = sys.argv[1]
    batch_id = int(sys.argv[2])
    scanned = sys.argv[3].split(",") if sys.argv[3] else []
    recover_partial_batch(plan_path, batch_id, scanned)
