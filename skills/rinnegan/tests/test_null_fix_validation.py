"""Tests for null-fix validation gate in rinnegan pipeline."""
import json
import os
import tempfile
import sys

import pytest

# Add scripts dir to path so we can import the validation function
SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from run_pipeline_lib import validate_null_fix_coverage

# -- Helpers -------------------------------------------------------------------

FINDING_TEMPLATE = {
    "id": "TST-001",
    "rule": "R01",
    "category": "typing",
    "file": "src/foo.ts",
    "line": 10,
    "snippet": "const x = 1;",
    "current_code": "const x = 1;",
    "description": "Test finding for validation",
    "explanation": "This is a test finding used by the null-fix validation tests.",
    "search_pattern": "const x",
    "phase": 2,
    "effort": "low",
    "layer": "utils",
    "scanner": "test-scanner",
    "completed_at": None,
    "resolution": None,
    "actual_line": None,
    "notes": "",
}


def _make_finding(
    finding_id: str,
    severity: str = "HIGH",
    target_code: str | None = None,
    fix_plan: list[dict] | None = None,
) -> dict:
    f = dict(FINDING_TEMPLATE)
    f["id"] = finding_id
    f["severity"] = severity
    f["target_code"] = target_code
    f["fix_plan"] = fix_plan
    return f


def _write_findings(tmp_dir: str, findings: list[dict]) -> str:
    """Write findings to a findings.jsonl inside a fake audit_dir structure."""
    data_dir = os.path.join(tmp_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, "findings.jsonl")
    with open(path, "w") as fh:
        for f in findings:
            fh.write(json.dumps(f) + "\n")
    return tmp_dir  # audit_dir


# -- Tests ---------------------------------------------------------------------

class TestNullFixValidationFailures:
    """Cases where any non-REVIEW finding lacks both target_code and fix_plan."""

    def test_all_non_review_findings_have_null_fixes(self) -> None:
        """Any non-REVIEW null-fix should block."""
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding("T-001", severity="HIGH"),
                _make_finding("T-002", severity="CRITICAL"),
                _make_finding("T-003", severity="MEDIUM"),
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert result["triggered"]
            assert result["null_fix_count"] == 3
            assert result["non_review_count"] == 3
            assert result["percent"] == pytest.approx(100.0)

    def test_above_threshold_mixed(self) -> None:
        """Mixed valid/invalid findings still block when any invalid finding exists."""
        with tempfile.TemporaryDirectory() as tmp:
            good = [
                _make_finding(f"G-{i:03d}", severity="HIGH", target_code="fix()")
                for i in range(8)
            ]
            bad = [
                _make_finding(f"B-{i:03d}", severity="HIGH")
                for i in range(2)
            ]
            audit_dir = _write_findings(tmp, good + bad)
            result = validate_null_fix_coverage(audit_dir)
            assert result["triggered"]
            assert result["null_fix_count"] == 2
            assert result["non_review_count"] == 10
            assert result["percent"] == pytest.approx(20.0)


class TestNullFixValidationPassingCases:
    """Cases where all non-REVIEW findings carry target_code or fix_plan."""

    def test_all_findings_have_target_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding(f"OK-{i:03d}", severity="HIGH", target_code="fixed()")
                for i in range(20)
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert not result["triggered"]
            assert result["null_fix_count"] == 0

    def test_all_findings_have_fix_plan(self) -> None:
        plan = [{"step": 1, "action": "edit", "file": "x.ts", "description": "fix it"}]
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding(f"FP-{i:03d}", severity="MEDIUM", fix_plan=plan)
                for i in range(10)
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert not result["triggered"]

    def test_single_invalid_finding_still_triggers(self) -> None:
        """A single invalid non-REVIEW finding is enough to fail the contract."""
        with tempfile.TemporaryDirectory() as tmp:
            good = [
                _make_finding(f"G-{i:03d}", severity="HIGH", target_code="fix()")
                for i in range(19)
            ]
            bad = [_make_finding("B-000", severity="HIGH")]
            audit_dir = _write_findings(tmp, good + bad)
            result = validate_null_fix_coverage(audit_dir)
            assert result["non_review_count"] == 20
            assert result["null_fix_count"] == 1
            assert result["percent"] == pytest.approx(5.0)
            assert result["triggered"]


class TestNullFixValidationReviewExclusion:
    """REVIEW-severity findings with both null should NOT count toward the failure rate."""

    def test_review_findings_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            good = [
                _make_finding(f"G-{i:03d}", severity="HIGH", target_code="fix()")
                for i in range(10)
            ]
            reviews = [
                _make_finding(f"R-{i:03d}", severity="REVIEW")
                for i in range(50)
            ]
            audit_dir = _write_findings(tmp, good + reviews)
            result = validate_null_fix_coverage(audit_dir)
            assert result["non_review_count"] == 10
            assert result["null_fix_count"] == 0
            assert not result["triggered"]

    def test_review_does_not_inflate_denominator(self) -> None:
        """REVIEW findings must not appear in non_review_count."""
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding("R-001", severity="REVIEW"),
                _make_finding("H-001", severity="HIGH", target_code="ok()"),
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert result["non_review_count"] == 1
            assert result["null_fix_count"] == 0


class TestNullFixValidationEdgeCases:
    """Edge cases: empty file, only REVIEW, missing file."""

    def test_empty_findings_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = os.path.join(tmp, "data")
            os.makedirs(data_dir)
            open(os.path.join(data_dir, "findings.jsonl"), "w").close()
            result = validate_null_fix_coverage(tmp)
            assert not result["triggered"]
            assert result["non_review_count"] == 0
            assert result["null_fix_count"] == 0

    def test_missing_findings_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = validate_null_fix_coverage(tmp)
            assert not result["triggered"]
            assert result["non_review_count"] == 0

    def test_empty_fix_plan_counts_as_null(self) -> None:
        """An empty list for fix_plan should be treated as null (no fix)."""
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding("E-001", severity="HIGH", fix_plan=[]),
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert result["null_fix_count"] == 1
            assert result["triggered"]

    def test_empty_string_target_code_counts_as_null(self) -> None:
        """An empty string for target_code should be treated as null."""
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                _make_finding("E-002", severity="HIGH", target_code=""),
            ]
            audit_dir = _write_findings(tmp, findings)
            result = validate_null_fix_coverage(audit_dir)
            assert result["null_fix_count"] == 1
            assert result["triggered"]
