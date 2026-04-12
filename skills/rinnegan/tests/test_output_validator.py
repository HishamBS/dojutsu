"""Tests for output_validator.py -- three-tier completeness checks."""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from output_validator import (
    is_output_complete,
    validate_aggregation_completeness,
    validate_enrichment_completeness,
    validate_jsonl_integrity,
)


def _write_jsonl(path: str, entries: list[dict[str, object]]) -> None:
    """Write a JSONL file from dicts."""
    with open(path, "w") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")


def _write_sentinel(path: str, lines: int, **extras: object) -> None:
    """Write a .done sentinel file."""
    payload: dict[str, object] = {"lines": lines}
    payload.update(extras)
    with open(path, "w") as f:
        json.dump(payload, f)


class TestIsOutputCompleteTier1:
    """Tier 1: sentinel exists."""

    def test_sentinel_matches_line_count(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(output, [{"a": 1}, {"b": 2}])
        _write_sentinel(output + ".done", lines=2)

        assert is_output_complete(output) is True

    def test_sentinel_mismatch_line_count(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(output, [{"a": 1}])
        _write_sentinel(output + ".done", lines=5)

        assert is_output_complete(output) is False


class TestIsOutputCompleteTier2:
    """Tier 2: no sentinel, valid JSONL auto-recovers."""

    def test_valid_jsonl_auto_creates_sentinel(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(output, [{"a": 1}, {"b": 2}, {"c": 3}])

        assert is_output_complete(output) is True
        sentinel_path = output + ".done"
        assert os.path.isfile(sentinel_path)

        with open(sentinel_path) as f:
            sentinel = json.load(f)
        assert sentinel["lines"] == 3
        assert sentinel["auto_recovered"] is True
        assert "timestamp" in sentinel

    def test_truncated_last_line_fails(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "findings.jsonl")
        with open(output, "w") as f:
            f.write(json.dumps({"valid": True}) + "\n")
            f.write('{"truncated": tru')  # invalid JSON

        assert is_output_complete(output) is False
        assert not os.path.isfile(output + ".done")


class TestIsOutputCompleteTier3:
    """Tier 3: no file or empty file."""

    def test_no_file_returns_false(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "nonexistent.jsonl")
        assert is_output_complete(output) is False

    def test_empty_file_returns_false(self, tmp_path: object) -> None:
        output = os.path.join(str(tmp_path), "empty.jsonl")
        with open(output, "w") as f:
            f.write("")
        assert is_output_complete(output) is False


class TestValidateJsonlIntegrity:
    """Tests for validate_jsonl_integrity."""

    def test_valid_file(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "valid.jsonl")
        _write_jsonl(path, [{"a": 1}, {"b": 2}, {"c": 3}])

        valid, total, error = validate_jsonl_integrity(path)
        assert valid == 3
        assert total == 3
        assert error is None

    def test_truncated_line_returns_error(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "bad.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"ok": True}) + "\n")
            f.write('{"broken": ')

        valid, total, error = validate_jsonl_integrity(path)
        assert valid == 1
        assert total == 2
        assert error is not None
        assert "line 2" in error

    def test_empty_file(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "empty.jsonl")
        with open(path, "w") as f:
            f.write("")

        valid, total, error = validate_jsonl_integrity(path)
        assert valid == 0
        assert total == 0
        assert error is None

    def test_blank_lines_ignored(self, tmp_path: object) -> None:
        path = os.path.join(str(tmp_path), "blanks.jsonl")
        with open(path, "w") as f:
            f.write("\n")
            f.write(json.dumps({"a": 1}) + "\n")
            f.write("   \n")
            f.write(json.dumps({"b": 2}) + "\n")
            f.write("\n")

        valid, total, error = validate_jsonl_integrity(path)
        assert valid == 2
        assert total == 2
        assert error is None


class TestValidateAggregationCompleteness:
    """Tests for validate_aggregation_completeness."""

    def test_complete_aggregation(self, tmp_path: object) -> None:
        scanner_dir = os.path.join(str(tmp_path), "scanner-output")
        os.makedirs(scanner_dir)
        _write_jsonl(os.path.join(scanner_dir, "s1.jsonl"), [{"f": 1}] * 10)
        _write_jsonl(os.path.join(scanner_dir, "s2.jsonl"), [{"f": 2}] * 10)

        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [{"f": "agg"}] * 15)

        complete, stats = validate_aggregation_completeness(findings, scanner_dir)
        assert complete is True
        assert "findings=15" in stats

    def test_incomplete_aggregation(self, tmp_path: object) -> None:
        scanner_dir = os.path.join(str(tmp_path), "scanner-output")
        os.makedirs(scanner_dir)
        _write_jsonl(os.path.join(scanner_dir, "s1.jsonl"), [{"f": 1}] * 100)

        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [{"f": "agg"}] * 10)

        complete, reason = validate_aggregation_completeness(findings, scanner_dir)
        assert complete is False
        assert "incomplete" in reason

    def test_rejected_files_excluded(self, tmp_path: object) -> None:
        scanner_dir = os.path.join(str(tmp_path), "scanner-output")
        os.makedirs(scanner_dir)
        _write_jsonl(os.path.join(scanner_dir, "s1.jsonl"), [{"f": 1}] * 10)
        _write_jsonl(os.path.join(scanner_dir, "s1.jsonl.rejected"), [{"r": 1}] * 50)
        _write_jsonl(os.path.join(scanner_dir, "s1.jsonl.done"), [{"d": 1}] * 50)

        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [{"f": "agg"}] * 8)

        complete, stats = validate_aggregation_completeness(findings, scanner_dir)
        assert complete is True


class TestValidateEnrichmentCompleteness:
    """Tests for validate_enrichment_completeness."""

    def test_complete_enrichment(self, tmp_path: object) -> None:
        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [
            {"layer": "api", "rule": "R05"},
            {"layer": "api", "rule": "R07"},
            {"layer": "ui", "rule": "R04"},
        ])

        enriched_dir = os.path.join(str(tmp_path), "enriched")
        os.makedirs(enriched_dir)
        _write_jsonl(os.path.join(enriched_dir, "api.jsonl"), [{"e": 1}, {"e": 2}])
        _write_jsonl(os.path.join(enriched_dir, "ui.jsonl"), [{"e": 3}])

        complete, incomplete = validate_enrichment_completeness(findings, enriched_dir)
        assert "api" in complete
        assert "ui" in complete
        assert len(incomplete) == 0

    def test_missing_enrichment_layer(self, tmp_path: object) -> None:
        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [
            {"layer": "api", "rule": "R05"},
            {"layer": "db", "rule": "R01"},
        ])

        enriched_dir = os.path.join(str(tmp_path), "enriched")
        os.makedirs(enriched_dir)
        _write_jsonl(os.path.join(enriched_dir, "api.jsonl"), [{"e": 1}])
        # db.jsonl missing

        complete, incomplete = validate_enrichment_completeness(findings, enriched_dir)
        assert "api" in complete
        assert "db" in incomplete

    def test_under_threshold_enrichment(self, tmp_path: object) -> None:
        findings = os.path.join(str(tmp_path), "findings.jsonl")
        _write_jsonl(findings, [{"layer": "api", "rule": f"R{i:02d}"} for i in range(10)])

        enriched_dir = os.path.join(str(tmp_path), "enriched")
        os.makedirs(enriched_dir)
        # Only 5 out of 10 -- 50% < 80% threshold
        _write_jsonl(os.path.join(enriched_dir, "api.jsonl"), [{"e": i} for i in range(5)])

        complete, incomplete = validate_enrichment_completeness(findings, enriched_dir)
        assert "api" in incomplete
        assert len(complete) == 0
