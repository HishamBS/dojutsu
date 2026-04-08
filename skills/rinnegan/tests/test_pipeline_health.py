#!/usr/bin/env python3
"""Tests for pipeline_health -- verifies health report generation."""
from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from pipeline_health import write_health_report
from tool_runner import ToolResult


REQUIRED_REPORT_FIELDS = {
    "timestamp",
    "tools_available",
    "tools_succeeded",
    "tools_skipped",
    "tools_failed",
    "tools_timed_out",
    "total_deterministic_findings",
    "total_files",
    "total_loc",
    "tool_results",
}


class TestWriteHealthReport:
    """write_health_report generates correct JSON with all required fields."""

    def test_all_required_fields_present(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="eslint", status="success", finding_count=5, duration_ms=1200),
            ToolResult(tool="ruff", status="success", finding_count=3, duration_ms=800),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        for field in REQUIRED_REPORT_FIELDS:
            assert field in report, f"Missing required field: {field}"

    def test_counts_match_results(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="eslint", status="success", finding_count=10, duration_ms=500),
            ToolResult(tool="tsc", status="failed", error="parse error", duration_ms=200),
            ToolResult(tool="semgrep", status="timeout", error="timed out", duration_ms=300000),
            ToolResult(tool="coverage", status="skipped", error="no runner", duration_ms=1),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        assert report["tools_available"] == 4
        assert report["tools_succeeded"] == 1
        assert report["tools_failed"] == 1
        assert report["tools_timed_out"] == 1
        assert report["tools_skipped"] == 1
        assert report["total_deterministic_findings"] == 10

    def test_json_file_written_to_disk(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="ruff", status="success", finding_count=2, duration_ms=100),
        ]
        write_health_report(audit_dir, results, "/fake/project")
        output_path = os.path.join(audit_dir, "data", "pipeline-health.json")
        assert os.path.isfile(output_path)
        with open(output_path) as f:
            data = json.load(f)
        assert data["tools_succeeded"] == 1

    def test_per_tool_breakdown(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="eslint", status="success", finding_count=5, duration_ms=1200),
            ToolResult(tool="mypy", status="failed", error="crash", duration_ms=100),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        tool_list = report["tool_results"]
        assert len(tool_list) == 2
        eslint_entry = tool_list[0]
        assert eslint_entry["tool"] == "eslint"
        assert eslint_entry["status"] == "success"
        assert eslint_entry["findings"] == 5
        assert eslint_entry["duration_ms"] == 1200
        mypy_entry = tool_list[1]
        assert mypy_entry["tool"] == "mypy"
        assert mypy_entry["error"] == "crash"

    def test_reads_inventory_for_project_metrics(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        data_dir = os.path.join(audit_dir, "data")
        os.makedirs(data_dir, exist_ok=True)
        inventory = {
            "files": [{"file": "a.ts"}, {"file": "b.ts"}, {"file": "c.ts"}],
            "total_loc": 5000,
        }
        with open(os.path.join(data_dir, "inventory.json"), "w") as f:
            json.dump(inventory, f)
        results = [
            ToolResult(tool="eslint", status="success", finding_count=1, duration_ms=50),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        assert report["total_files"] == 3
        assert report["total_loc"] == 5000

    def test_handles_missing_inventory(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="ruff", status="success", finding_count=0, duration_ms=10),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        assert report["total_files"] == 0
        assert report["total_loc"] == 0

    def test_empty_results_list(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        report = write_health_report(audit_dir, [], "/fake/project")
        assert report["tools_available"] == 0
        assert report["tools_succeeded"] == 0
        assert report["total_deterministic_findings"] == 0
        assert report["tool_results"] == []

    def test_error_field_only_present_when_nonempty(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        results = [
            ToolResult(tool="eslint", status="success", finding_count=0, duration_ms=100),
            ToolResult(tool="ruff", status="failed", error="boom", duration_ms=50),
        ]
        report = write_health_report(audit_dir, results, "/fake/project")
        eslint_entry = report["tool_results"][0]
        ruff_entry = report["tool_results"][1]
        assert "error" not in eslint_entry
        assert ruff_entry["error"] == "boom"

    def test_timestamp_is_iso_format(self, tmp_path: str) -> None:
        audit_dir = str(tmp_path)
        os.makedirs(os.path.join(audit_dir, "data"), exist_ok=True)
        report = write_health_report(audit_dir, [], "/fake/project")
        ts = report["timestamp"]
        assert isinstance(ts, str)
        # ISO 8601 contains a 'T' separator
        assert "T" in ts
