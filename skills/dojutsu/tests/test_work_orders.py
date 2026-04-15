"""Tests for file-backed work-order checkpoints."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile


SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
MODULE_PATH = os.path.join(SCRIPTS_DIR, "work_orders.py")
spec = importlib.util.spec_from_file_location("dojutsu_work_orders", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
write_scan_work_orders = module.write_scan_work_orders
write_enrichment_work_orders = module.write_enrichment_work_orders


def _read_json(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)


def test_scan_work_order_tracks_artifact_completion() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        audit_dir = tmp
        scan_plan = {
            "batches": [
                {
                    "id": 1,
                    "layer": "components",
                    "files": ["src/App.tsx"],
                    "output_file": "data/scanner-output/batch-1.jsonl",
                    "status": "pending",
                }
            ]
        }

        write_scan_work_orders(audit_dir, scan_plan)
        work_dir = os.path.join(audit_dir, "data", "work-orders", "scanner", "batch-1")
        status_path = os.path.join(work_dir, "status.json")
        assert _read_json(status_path)["state"] == "pending"
        assert not os.path.exists(os.path.join(work_dir, "response.normalized.json"))

        os.makedirs(os.path.join(audit_dir, "data", "scanner-output"), exist_ok=True)
        with open(os.path.join(audit_dir, "data", "scanner-output", "batch-1.jsonl"), "w") as fh:
            fh.write("{\"id\":\"SCAN-001\"}\n")

        write_scan_work_orders(audit_dir, scan_plan)
        status = _read_json(status_path)
        normalized = _read_json(os.path.join(work_dir, "response.normalized.json"))
        assert status["state"] == "complete"
        assert status["artifact_present"] is True
        assert normalized["artifact_path"] == "data/scanner-output/batch-1.jsonl"
        assert normalized["line_count"] == 1


def test_enrichment_work_order_preserves_created_at_and_completion() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        audit_dir = tmp
        counts = {"services": 2}
        write_enrichment_work_orders(audit_dir, counts)
        work_dir = os.path.join(audit_dir, "data", "work-orders", "enrichment", "services")
        request_path = os.path.join(work_dir, "request.json")
        initial_request = _read_json(request_path)

        os.makedirs(os.path.join(audit_dir, "data", "enriched"), exist_ok=True)
        with open(os.path.join(audit_dir, "data", "enriched", "services.jsonl"), "w") as fh:
            fh.write("{\"id\":\"ENR-001\"}\n")

        write_enrichment_work_orders(audit_dir, counts)
        updated_request = _read_json(request_path)
        status = _read_json(os.path.join(work_dir, "status.json"))
        assert updated_request["created_at"] == initial_request["created_at"]
        assert status["state"] == "complete"
