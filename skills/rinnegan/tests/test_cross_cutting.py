"""Tests for deterministic cross-cutting detection."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from detect_cross_cutting import detect_groups, apply_cross_cutting


class TestDetectGroups:
    def test_groups_spanning_3_files(self) -> None:
        findings = [
            {"id": "1", "rule": "R09", "search_pattern": "console\\.log", "file": "a.ts", "description": "console.log"},
            {"id": "2", "rule": "R09", "search_pattern": "console\\.log", "file": "b.ts", "description": "console.log"},
            {"id": "3", "rule": "R09", "search_pattern": "console\\.log", "file": "c.ts", "description": "console.log"},
        ]
        groups = detect_groups(findings, min_files=3)
        assert len(groups) == 1
        assert groups[0]["count"] == 3
        assert groups[0]["files"] == 3
        assert groups[0]["rule"] == "R09"

    def test_under_threshold_not_grouped(self) -> None:
        findings = [
            {"id": "1", "rule": "R05", "search_pattern": "eval", "file": "a.ts", "description": "eval"},
            {"id": "2", "rule": "R05", "search_pattern": "eval", "file": "b.ts", "description": "eval"},
        ]
        groups = detect_groups(findings, min_files=3)
        assert len(groups) == 0

    def test_mutates_findings_in_place(self) -> None:
        findings = [
            {"id": "1", "rule": "R09", "search_pattern": "console\\.log", "file": "a.ts", "description": "x"},
            {"id": "2", "rule": "R09", "search_pattern": "console\\.log", "file": "b.ts", "description": "x"},
            {"id": "3", "rule": "R09", "search_pattern": "console\\.log", "file": "c.ts", "description": "x"},
        ]
        detect_groups(findings, min_files=3)
        for f in findings:
            assert f["cross_cutting"] is True
            assert "R09" in f["cross_cutting_group"]

    def test_same_file_different_lines_counts_once(self) -> None:
        findings = [
            {"id": "1", "rule": "R09", "search_pattern": "console\\.log", "file": "a.ts", "description": "x"},
            {"id": "2", "rule": "R09", "search_pattern": "console\\.log", "file": "a.ts", "description": "x"},
            {"id": "3", "rule": "R09", "search_pattern": "console\\.log", "file": "b.ts", "description": "x"},
        ]
        groups = detect_groups(findings, min_files=3)
        assert len(groups) == 0  # only 2 unique files

    def test_different_rules_not_merged(self) -> None:
        findings = [
            {"id": "1", "rule": "R09", "search_pattern": "console\\.log", "file": "a.ts", "description": "x"},
            {"id": "2", "rule": "R05", "search_pattern": "console\\.log", "file": "b.ts", "description": "x"},
            {"id": "3", "rule": "R09", "search_pattern": "console\\.log", "file": "c.ts", "description": "x"},
        ]
        groups = detect_groups(findings, min_files=3)
        assert len(groups) == 0  # R09 only has 2 files, R05 has 1

    def test_sorted_by_count_descending(self) -> None:
        findings = [
            {"id": "1", "rule": "R09", "search_pattern": "console\\.log", "file": f"{i}.ts", "description": "x"}
            for i in range(5)
        ] + [
            {"id": "6", "rule": "R05", "search_pattern": "eval", "file": f"{i}.ts", "description": "y"}
            for i in range(3)
        ]
        groups = detect_groups(findings, min_files=3)
        assert len(groups) == 2
        assert groups[0]["count"] >= groups[1]["count"]


class TestApplyCrossCutting:
    def test_writes_back_to_file(self) -> None:
        findings = [
            {"id": str(i), "rule": "R09", "search_pattern": "console\\.log", "file": f"{i}.ts", "description": "x"}
            for i in range(4)
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            for finding in findings:
                f.write(json.dumps(finding) + "\n")
            path = f.name

        try:
            group_count = apply_cross_cutting(path, min_files=3)
            assert group_count == 1

            with open(path) as f:
                result = [json.loads(line) for line in f]
            assert all(r.get("cross_cutting") is True for r in result)
        finally:
            os.unlink(path)
