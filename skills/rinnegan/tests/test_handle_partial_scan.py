"""Tests for SCAN_PARTIAL recovery -- handle_partial_scan.py."""
import json
import os
import sys
import tempfile

import pytest

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from handle_partial_scan import recover_partial_batch


# -- Helpers -------------------------------------------------------------------


def _make_plan(batches: list[dict]) -> tuple[str, str]:
    """Write a scan-plan.json to a temp dir and return (tmp_dir, plan_path)."""
    tmp_dir = tempfile.mkdtemp()
    plan = {
        "total_batches": len(batches),
        "completed": 0,
        "batches": batches,
    }
    plan_path = os.path.join(tmp_dir, "scan-plan.json")
    with open(plan_path, "w") as fh:
        json.dump(plan, fh, indent=2)
    return tmp_dir, plan_path


def _read_plan(plan_path: str) -> dict:
    with open(plan_path) as fh:
        return json.load(fh)


def _batch(
    batch_id: int,
    files: list[str],
    layer: str = "services",
    status: str = "pending",
) -> dict:
    return {
        "id": batch_id,
        "layer": layer,
        "files": files,
        "status": status,
        "output_file": f"data/scanner-output/scanner-{batch_id}-{layer}.jsonl",
        "finding_count": 0,
    }


# -- Tests ---------------------------------------------------------------------


class TestPartialScanRecovery:
    """Core recovery logic tests."""

    def test_creates_followup_batch(self) -> None:
        """5 files, 3 scanned -> batch marked partial, new batch with 2 remaining."""
        all_files = ["a.py", "b.py", "c.py", "d.py", "e.py"]
        scanned = ["a.py", "b.py", "c.py"]
        _, plan_path = _make_plan([_batch(1, all_files)])

        recover_partial_batch(plan_path, 1, scanned)

        plan = _read_plan(plan_path)
        original = plan["batches"][0]
        assert original["status"] == "partial"
        assert len(plan["batches"]) == 2

        followup = plan["batches"][1]
        assert followup["status"] == "pending"
        assert set(followup["files"]) == {"d.py", "e.py"}
        assert followup["parent_batch"] == 1

    def test_all_files_scanned_marks_complete(self) -> None:
        """All files scanned -> status=complete, no new batch."""
        all_files = ["a.py", "b.py", "c.py"]
        _, plan_path = _make_plan([_batch(1, all_files)])

        recover_partial_batch(plan_path, 1, all_files)

        plan = _read_plan(plan_path)
        assert plan["batches"][0]["status"] == "complete"
        assert len(plan["batches"]) == 1

    def test_no_files_scanned_increments_retry(self) -> None:
        """0 files scanned -> status stays pending, retries incremented."""
        all_files = ["a.py", "b.py", "c.py"]
        _, plan_path = _make_plan([_batch(1, all_files)])

        recover_partial_batch(plan_path, 1, [])

        plan = _read_plan(plan_path)
        batch = plan["batches"][0]
        assert batch["status"] == "pending"
        assert batch["retries"] == 1
        assert len(plan["batches"]) == 1

        # Second retry increments again
        recover_partial_batch(plan_path, 1, [])
        plan = _read_plan(plan_path)
        assert plan["batches"][0]["retries"] == 2

    def test_new_batch_gets_correct_id(self) -> None:
        """New batch id = max existing + 1."""
        _, plan_path = _make_plan([
            _batch(1, ["a.py", "b.py"], layer="services"),
            _batch(2, ["c.py", "d.py"], layer="utils"),
            _batch(5, ["e.py", "f.py", "g.py"], layer="api"),
        ])

        recover_partial_batch(plan_path, 5, ["e.py"])

        plan = _read_plan(plan_path)
        new_batch = plan["batches"][-1]
        assert new_batch["id"] == 6

    def test_new_batch_inherits_layer(self) -> None:
        """New batch has same layer as parent."""
        _, plan_path = _make_plan([
            _batch(1, ["a.py", "b.py", "c.py"], layer="domain"),
        ])

        recover_partial_batch(plan_path, 1, ["a.py"])

        plan = _read_plan(plan_path)
        followup = plan["batches"][-1]
        assert followup["layer"] == "domain"

    def test_total_batches_updated(self) -> None:
        """total_batches count is updated after creating a follow-up batch."""
        _, plan_path = _make_plan([
            _batch(1, ["a.py", "b.py", "c.py"]),
        ])

        recover_partial_batch(plan_path, 1, ["a.py"])

        plan = _read_plan(plan_path)
        assert plan["total_batches"] == 2

    def test_batch_not_found_raises(self) -> None:
        """Looking up a non-existent batch_id raises ValueError."""
        _, plan_path = _make_plan([_batch(1, ["a.py"])])

        with pytest.raises(ValueError, match="Batch 99 not found"):
            recover_partial_batch(plan_path, 99, ["a.py"])

    def test_preserves_other_batches(self) -> None:
        """Other batches in the plan are not affected by recovery."""
        _, plan_path = _make_plan([
            _batch(1, ["a.py", "b.py"], layer="services", status="complete"),
            _batch(2, ["c.py", "d.py", "e.py"], layer="utils"),
        ])

        recover_partial_batch(plan_path, 2, ["c.py"])

        plan = _read_plan(plan_path)
        assert plan["batches"][0]["status"] == "complete"
        assert plan["batches"][0]["id"] == 1
        assert plan["batches"][1]["status"] == "partial"
        followup = plan["batches"][2]
        assert set(followup["files"]) == {"d.py", "e.py"}
