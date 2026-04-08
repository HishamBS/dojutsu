"""Tests for quality gate engine and readiness trend tracking."""
import json
import os
import sys
import tempfile

import pytest

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from quality_gate import (
    DEFAULT_THRESHOLDS,
    SEVERITY_WEIGHTS,
    TIERS,
    QualityGateResult,
    evaluate_quality_gate,
    _compute_readiness_score,
    _count_by_severity,
    _count_by_rule,
    _compute_overall,
)
from readiness_trend import append_trend, get_trend

# -- Helpers -------------------------------------------------------------------


def _make_audit_dir(tmp: str) -> str:
    """Create minimal audit_dir structure with data/ directory."""
    data_dir = os.path.join(tmp, "data")
    os.makedirs(data_dir, exist_ok=True)
    return tmp


def _write_findings(audit_dir: str, findings: list[dict]) -> str:
    """Write findings.jsonl and return the path."""
    path = os.path.join(audit_dir, "data", "findings.jsonl")
    with open(path, "w") as fh:
        for f in findings:
            fh.write(json.dumps(f) + "\n")
    return path


def _write_health(audit_dir: str, health: dict) -> str:
    """Write pipeline-health.json and return the path."""
    path = os.path.join(audit_dir, "data", "pipeline-health.json")
    with open(path, "w") as fh:
        json.dump(health, fh)
    return path


def _write_inventory(audit_dir: str, total_loc: int) -> None:
    """Write a minimal inventory.json."""
    path = os.path.join(audit_dir, "data", "inventory.json")
    with open(path, "w") as fh:
        json.dump({"total_loc": total_loc, "files": [], "layers": {}}, fh)


def _make_finding(
    rule: str = "R14",
    severity: str = "MEDIUM",
    category: str = "build",
) -> dict:
    return {
        "id": "TST-001",
        "rule": rule,
        "severity": severity,
        "category": category,
        "file": "src/foo.py",
        "line": 10,
        "snippet": "x = 1",
        "current_code": "x = 1",
        "description": "Test finding",
        "explanation": "test",
        "search_pattern": "x = 1",
        "phase": 0,
        "effort": "low",
        "layer": "utils",
        "scanner": "test",
    }


# -- Readiness Score Calculation -----------------------------------------------


class TestReadinessScore:
    """Test readiness score calculation with known findings."""

    def test_zero_findings_gives_100(self) -> None:
        score = _compute_readiness_score([], total_loc=10000)
        assert score == 100.0

    def test_critical_findings_reduce_score_heavily(self) -> None:
        findings = [_make_finding(severity="CRITICAL") for _ in range(10)]
        score = _compute_readiness_score(findings, total_loc=10000)
        # 10 * 10.0 weight = 100; 100 / 10 KLOC = 10; 100 - 10 = 90
        assert score == 90.0

    def test_high_findings_reduce_score_moderately(self) -> None:
        findings = [_make_finding(severity="HIGH") for _ in range(10)]
        score = _compute_readiness_score(findings, total_loc=10000)
        # 10 * 3.0 = 30; 30 / 10 = 3; 100 - 3 = 97
        assert score == 97.0

    def test_medium_findings_reduce_score_slightly(self) -> None:
        findings = [_make_finding(severity="MEDIUM") for _ in range(100)]
        score = _compute_readiness_score(findings, total_loc=10000)
        # 100 * 1.0 = 100; 100 / 10 = 10; 100 - 10 = 90
        assert score == 90.0

    def test_low_findings_reduce_score_minimally(self) -> None:
        findings = [_make_finding(severity="LOW") for _ in range(100)]
        score = _compute_readiness_score(findings, total_loc=10000)
        # 100 * 0.2 = 20; 20 / 10 = 2; 100 - 2 = 98
        assert score == 98.0

    def test_mixed_severities(self) -> None:
        findings = [
            _make_finding(severity="CRITICAL"),
            _make_finding(severity="HIGH"),
            _make_finding(severity="HIGH"),
            _make_finding(severity="MEDIUM"),
            _make_finding(severity="MEDIUM"),
            _make_finding(severity="MEDIUM"),
            _make_finding(severity="LOW"),
        ]
        score = _compute_readiness_score(findings, total_loc=5000)
        # 10 + 3 + 3 + 1 + 1 + 1 + 0.2 = 19.2; 19.2 / 5 = 3.84; 100 - 3.84 = 96.16
        assert score == 96.16

    def test_score_clamped_to_zero(self) -> None:
        findings = [_make_finding(severity="CRITICAL") for _ in range(1000)]
        score = _compute_readiness_score(findings, total_loc=100)
        # massive weighted score on tiny codebase -> clamped to 0
        assert score == 0.0

    def test_small_codebase_avoids_division_by_zero(self) -> None:
        findings = [_make_finding(severity="MEDIUM")]
        score = _compute_readiness_score(findings, total_loc=0)
        # KLOC = max(0/1000, 0.1) = 0.1; 1.0 / 0.1 = 10; 100 - 10 = 90
        assert score == 90.0


# -- Tier Evaluation -----------------------------------------------------------


class TestTierEvaluation:
    """Test tier evaluation (PASS, WARN, FAIL)."""

    def test_build_tier_pass_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["build"]["status"] == "PASS"

    def test_build_tier_fail_with_critical_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R14", severity="CRITICAL") for _ in range(10)]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["build"]["status"] == "FAIL"

    def test_build_tier_warn_with_few_high_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R14", severity="HIGH") for _ in range(3)]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["build"]["status"] == "WARN"

    def test_security_tier_fail_with_criticals(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R05", severity="CRITICAL", category="security")]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["security"]["status"] == "FAIL"

    def test_security_tier_pass_with_no_vulns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            # Only medium findings for R14, none for R05
            findings = [_make_finding(rule="R14", severity="MEDIUM")]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["security"]["status"] == "PASS"

    def test_secrets_tier_fail_with_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R05-gitleaks", severity="CRITICAL", category="security")]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["secrets"]["status"] == "FAIL"

    def test_coverage_tier_pass_with_good_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            health_path = _write_health(audit_dir, {"coverage_line_pct": 85.0})
            result = evaluate_quality_gate(path, health_path=health_path, audit_dir=audit_dir)
            assert result["tiers"]["coverage"]["status"] == "PASS"

    def test_coverage_tier_fail_with_low_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            health_path = _write_health(audit_dir, {"coverage_line_pct": 30.0})
            result = evaluate_quality_gate(path, health_path=health_path, audit_dir=audit_dir)
            assert result["tiers"]["coverage"]["status"] == "FAIL"

    def test_coverage_tier_warn_no_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["coverage"]["status"] == "WARN"

    def test_duplication_tier_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            health_path = _write_health(audit_dir, {"duplication_pct": 2.0})
            result = evaluate_quality_gate(path, health_path=health_path, audit_dir=audit_dir)
            assert result["tiers"]["duplication"]["status"] == "PASS"

    def test_duplication_tier_fail_high_pct(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            health_path = _write_health(audit_dir, {"duplication_pct": 15.0})
            result = evaluate_quality_gate(path, health_path=health_path, audit_dir=audit_dir)
            assert result["tiers"]["duplication"]["status"] == "FAIL"

    def test_complexity_tier_pass_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["complexity"]["status"] == "PASS"

    def test_complexity_tier_fail_with_criticals(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R02", severity="CRITICAL", category="architecture")]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["complexity"]["status"] == "FAIL"

    def test_architecture_tier_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["architecture"]["status"] == "PASS"

    def test_architecture_tier_fail_with_highs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [
                _make_finding(rule="R03", severity="HIGH", category="architecture"),
                _make_finding(rule="R10", severity="HIGH", category="architecture"),
            ]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["tiers"]["architecture"]["status"] == "FAIL"


# -- Overall Verdict Logic -----------------------------------------------------


class TestOverallVerdict:
    """Test overall verdict logic."""

    def test_all_pass_gives_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory(audit_dir, 10000)
            health_path = _write_health(audit_dir, {
                "coverage_line_pct": 80.0,
                "duplication_pct": 2.0,
            })
            # No findings -> all tiers pass
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(
                path, health_path=health_path, audit_dir=audit_dir, total_loc=10000,
            )
            assert result["overall"] == "PASS"

    def test_warn_gives_conditional(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory(audit_dir, 10000)
            # No health -> coverage tier is WARN -> CONDITIONAL
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir, total_loc=10000)
            assert result["overall"] == "CONDITIONAL"

    def test_fail_gives_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R05", severity="CRITICAL", category="security")]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert result["overall"] == "FAIL"

    def test_low_readiness_score_triggers_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            # 50 critical findings on a 1000 LOC codebase
            findings = [_make_finding(severity="CRITICAL") for _ in range(50)]
            health_path = _write_health(audit_dir, {
                "coverage_line_pct": 80.0,
                "duplication_pct": 2.0,
            })
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(
                path, health_path=health_path, audit_dir=audit_dir, total_loc=1000,
            )
            # 50 * 10 = 500 weighted; 500 / 1 KLOC = 500; 100 - 500 -> clamped to 0
            assert result["readiness_score"] == 0.0
            assert result["overall"] == "FAIL"

    def test_custom_thresholds_override_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(rule="R05", severity="CRITICAL")]
            path = _write_findings(audit_dir, findings)
            # Allow 1 critical vuln
            result = evaluate_quality_gate(
                path, audit_dir=audit_dir,
                thresholds={"max_critical_vulns": 1},
            )
            # Security tier should not FAIL since we allow 1 critical
            assert result["tiers"]["security"]["status"] != "FAIL"


# -- Result Structure ----------------------------------------------------------


class TestResultStructure:
    """Verify the output has the expected shape."""

    def test_result_has_all_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            assert "readiness_score" in result
            assert "overall" in result
            assert "tiers" in result
            assert "summary" in result

    def test_all_tiers_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            for tier_key in TIERS:
                assert tier_key in result["tiers"]

    def test_summary_counts_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [
                _make_finding(severity="CRITICAL"),
                _make_finding(severity="CRITICAL"),
                _make_finding(severity="HIGH"),
                _make_finding(severity="MEDIUM"),
                _make_finding(severity="MEDIUM"),
                _make_finding(severity="LOW"),
            ]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            s = result["summary"]
            assert s["total_findings"] == 6
            assert s["critical"] == 2
            assert s["high"] == 1
            assert s["medium"] == 2
            assert s["low"] == 1

    def test_writes_quality_gate_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            evaluate_quality_gate(path, audit_dir=audit_dir)
            gate_path = os.path.join(audit_dir, "data", "quality-gate.json")
            assert os.path.isfile(gate_path)
            with open(gate_path) as fh:
                loaded = json.load(fh)
            assert "readiness_score" in loaded
            assert "overall" in loaded

    def test_tools_run_from_health(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            health_path = _write_health(audit_dir, {
                "tools_succeeded": 7,
                "tools_skipped": 1,
                "tools_failed": 1,
                "coverage_line_pct": 70.0,
                "duplication_pct": 3.0,
            })
            result = evaluate_quality_gate(path, health_path=health_path, audit_dir=audit_dir)
            assert result["summary"]["tools_run"] == 9

    def test_resolves_loc_from_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory(audit_dir, 5000)
            findings = [_make_finding(severity="CRITICAL") for _ in range(5)]
            path = _write_findings(audit_dir, findings)
            result = evaluate_quality_gate(path, audit_dir=audit_dir)
            # 5 * 10 = 50; 50 / 5 KLOC = 10; 100 - 10 = 90
            assert result["readiness_score"] == 90.0


# -- Trend Tracking -----------------------------------------------------------


class TestTrendTracking:
    """Test trend tracking (2+ entries)."""

    def test_no_trend_with_zero_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            assert get_trend(audit_dir) is None

    def test_no_trend_with_one_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=80.0, findings=50, critical=2)
            assert get_trend(audit_dir) is None

    def test_trend_with_two_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=75.0, findings=80, critical=5)
            append_trend(audit_dir, score=84.0, findings=50, critical=2)
            trend = get_trend(audit_dir)
            assert trend is not None
            assert trend["current"] == 84.0
            assert trend["previous"] == 75.0
            assert trend["delta"] == 9.0
            assert trend["direction"] == "improving"

    def test_trend_declining(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=90.0, findings=30, critical=0)
            append_trend(audit_dir, score=85.0, findings=40, critical=1)
            trend = get_trend(audit_dir)
            assert trend is not None
            assert trend["delta"] == -5.0
            assert trend["direction"] == "declining"

    def test_trend_stable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=80.0, findings=50, critical=2)
            append_trend(audit_dir, score=80.0, findings=50, critical=2)
            trend = get_trend(audit_dir)
            assert trend is not None
            assert trend["delta"] == 0.0
            assert trend["direction"] == "stable"

    def test_trend_with_many_entries_uses_last_two(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=60.0, findings=100, critical=10)
            append_trend(audit_dir, score=70.0, findings=80, critical=5)
            append_trend(audit_dir, score=84.0, findings=50, critical=2)
            trend = get_trend(audit_dir)
            assert trend is not None
            assert trend["current"] == 84.0
            assert trend["previous"] == 70.0
            assert trend["delta"] == 14.0

    def test_trend_with_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=80.0, findings=50, critical=2, coverage=72.3)
            # Verify the entry was written with coverage
            path = os.path.join(audit_dir, "data", "readiness-history.jsonl")
            with open(path) as fh:
                entry = json.loads(fh.readline())
            assert entry["coverage"] == 72.3

    def test_trend_integrated_with_quality_gate(self) -> None:
        """Quality gate should auto-populate trend data."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            path = _write_findings(audit_dir, [])
            # First run: no trend yet (only 1 entry after this call)
            result1 = evaluate_quality_gate(path, audit_dir=audit_dir, total_loc=1000)
            assert result1.get("trend") is None

            # Second run: trend available
            result2 = evaluate_quality_gate(path, audit_dir=audit_dir, total_loc=1000)
            assert result2.get("trend") is not None
            assert result2["trend"]["direction"] == "stable"

    def test_history_file_created(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=80.0, findings=50, critical=2)
            path = os.path.join(audit_dir, "data", "readiness-history.jsonl")
            assert os.path.isfile(path)

    def test_history_entries_are_valid_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            append_trend(audit_dir, score=80.0, findings=50, critical=2)
            append_trend(audit_dir, score=85.5, findings=40, critical=1, coverage=60.0)
            path = os.path.join(audit_dir, "data", "readiness-history.jsonl")
            with open(path) as fh:
                for line in fh:
                    entry = json.loads(line.strip())
                    assert "timestamp" in entry
                    assert "score" in entry
                    assert "findings" in entry
                    assert "critical" in entry
                    assert "coverage" in entry
