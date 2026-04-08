"""Tests for validate_scanner_output.py."""
from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from validate_scanner_output import validate_scanner_file


def _make_finding(**overrides: object) -> dict[str, object]:
    """Create a minimal valid finding with overrides."""
    base: dict[str, object] = {
        "rule": "R05",
        "file": "src/app.ts",
        "line": 10,
        "description": "TLS validation disabled",
        "severity": "HIGH",
        "category": "security",
    }
    base.update(overrides)
    return base


def _write_jsonl(path: str, findings: list[dict[str, object] | str]) -> None:
    """Write a JSONL file from dicts or raw strings."""
    with open(path, "w") as f:
        for entry in findings:
            if isinstance(entry, str):
                f.write(entry + "\n")
            else:
                f.write(json.dumps(entry) + "\n")


class TestValidFindings:
    """Valid findings pass through unchanged."""

    def test_valid_findings_pass_through(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        findings = [
            _make_finding(),
            _make_finding(rule="R07", line=20, category="typing"),
        ]
        _write_jsonl(path, findings)

        valid, rejected, warnings = validate_scanner_file(path)
        assert valid == 2
        assert rejected == 0

        with open(path) as f:
            lines = [json.loads(line) for line in f if line.strip()]
        assert len(lines) == 2
        assert lines[0]["rule"] == "R05"
        assert lines[1]["rule"] == "R07"

    def test_no_rejected_file_when_all_valid(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding()])

        validate_scanner_file(path)
        assert not os.path.exists(path + ".rejected")


class TestMissingRequiredFields:
    """Findings missing required fields are rejected."""

    def test_missing_rule(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad = _make_finding()
        del bad["rule"]
        _write_jsonl(path, [bad])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_missing_file_field(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad = _make_finding()
        del bad["file"]
        _write_jsonl(path, [bad])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_missing_line(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad = _make_finding()
        del bad["line"]
        _write_jsonl(path, [bad])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_missing_description(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad = _make_finding()
        del bad["description"]
        _write_jsonl(path, [bad])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_rejected_written_to_file(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad = _make_finding()
        del bad["rule"]
        _write_jsonl(path, [bad])

        validate_scanner_file(path)
        assert os.path.exists(path + ".rejected")
        with open(path + ".rejected") as f:
            rejected_lines = [json.loads(line) for line in f if line.strip()]
        assert len(rejected_lines) == 1
        assert "missing_fields" in rejected_lines[0].get("_reason", "")


class TestPhantomFiles:
    """Findings referencing files not in inventory are rejected."""

    def test_phantom_file_rejected_with_inventory(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(file="nonexistent/file.ts")])

        inventory_files = {"src/app.ts", "src/utils.ts"}
        valid, rejected, _ = validate_scanner_file(path, inventory_files)
        assert valid == 0
        assert rejected == 1

    def test_known_file_passes_with_inventory(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(file="src/app.ts")])

        inventory_files = {"src/app.ts", "src/utils.ts"}
        valid, rejected, _ = validate_scanner_file(path, inventory_files)
        assert valid == 1
        assert rejected == 0

    def test_no_inventory_allows_all_files(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(file="anything/goes.ts")])

        valid, rejected, _ = validate_scanner_file(path, inventory_files=None)
        assert valid == 1
        assert rejected == 0


class TestInvalidJSON:
    """Invalid JSON lines are rejected."""

    def test_malformed_json_rejected(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [
            "this is not json at all",
            json.dumps(_make_finding()),
        ])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 1
        assert rejected == 1

    def test_json_array_rejected(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, ['[1, 2, 3]'])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_empty_lines_skipped(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        with open(path, "w") as f:
            f.write("\n")
            f.write(json.dumps(_make_finding()) + "\n")
            f.write("\n")

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 1
        assert rejected == 0


class TestCategoryNormalization:
    """Non-canonical categories are normalized, not rejected."""

    def test_category_normalized_via_rule(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        finding = _make_finding(rule="R07", category="strict typing")
        _write_jsonl(path, [finding])

        validate_scanner_file(path)
        with open(path) as f:
            result = json.loads(f.readline())
        assert result["category"] == "typing"

    def test_canonical_category_unchanged(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        finding = _make_finding(category="security")
        _write_jsonl(path, [finding])

        validate_scanner_file(path)
        with open(path) as f:
            result = json.loads(f.readline())
        assert result["category"] == "security"


class TestSeverityNormalization:
    """Invalid severities are normalized to MEDIUM."""

    def test_invalid_severity_becomes_medium(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        finding = _make_finding(severity="URGENT")
        _write_jsonl(path, [finding])

        validate_scanner_file(path)
        with open(path) as f:
            result = json.loads(f.readline())
        assert result["severity"] == "MEDIUM"

    def test_lowercase_severity_uppercased(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        finding = _make_finding(severity="high")
        _write_jsonl(path, [finding])

        validate_scanner_file(path)
        with open(path) as f:
            result = json.loads(f.readline())
        assert result["severity"] == "HIGH"

    def test_valid_severity_unchanged(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        finding = _make_finding(severity="CRITICAL")
        _write_jsonl(path, [finding])

        validate_scanner_file(path)
        with open(path) as f:
            result = json.loads(f.readline())
        assert result["severity"] == "CRITICAL"


class TestDensityWarning:
    """Density warning triggered when single rule > 60%."""

    def test_density_warning_triggered(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        # 8 R13 findings + 2 R05 findings = 80% R13
        findings = [_make_finding(rule="R13", line=i + 1) for i in range(8)]
        findings.extend([_make_finding(rule="R05", line=i + 20) for i in range(2)])
        _write_jsonl(path, findings)

        valid, rejected, warnings = validate_scanner_file(path)
        assert valid == 10
        assert rejected == 0
        assert len(warnings) >= 1
        assert "R13" in warnings[0]
        assert "60%" in warnings[0]

    def test_no_density_warning_under_threshold(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        # 3 R05 + 3 R07 + 4 R13 = 40% max
        findings = (
            [_make_finding(rule="R05", line=i + 1) for i in range(3)]
            + [_make_finding(rule="R07", line=i + 10, category="typing") for i in range(3)]
            + [_make_finding(rule="R13", line=i + 20) for i in range(4)]
        )
        _write_jsonl(path, findings)

        valid, rejected, warnings = validate_scanner_file(path)
        assert valid == 10
        assert len(warnings) == 0


class TestLineNumberValidation:
    """Line numbers must be positive integers."""

    def test_zero_line_rejected(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(line=0)])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_negative_line_rejected(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(line=-5)])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1

    def test_string_line_rejected(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        _write_jsonl(path, [_make_finding(line="ten")])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 0
        assert rejected == 1


class TestRejectedFile:
    """Rejected findings are written to .rejected file."""

    def test_rejected_file_written(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        bad1 = _make_finding()
        del bad1["rule"]
        bad2 = _make_finding(line=0)
        good = _make_finding()
        _write_jsonl(path, [bad1, bad2, good])

        valid, rejected, _ = validate_scanner_file(path)
        assert valid == 1
        assert rejected == 2
        assert os.path.exists(path + ".rejected")
        with open(path + ".rejected") as f:
            rejected_lines = [json.loads(line) for line in f if line.strip()]
        assert len(rejected_lines) == 2

    def test_stale_rejected_file_removed_when_all_valid(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "scanner.jsonl")
        # Create a stale .rejected file
        with open(path + ".rejected", "w") as f:
            f.write('{"stale": true}\n')

        _write_jsonl(path, [_make_finding()])
        validate_scanner_file(path)
        assert not os.path.exists(path + ".rejected")
