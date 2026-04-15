"""Tests for deterministic audit statistics computation."""
import json
import os
import sys
import tempfile
from datetime import date

import pytest

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from compute_audit_stats import (
    PHASE_NAMES,
    RULE_NAMES,
    SEVERITY_LEVELS,
    compute_stats,
    write_stats,
)

# -- Fixtures -----------------------------------------------------------------


def _make_audit_dir(tmp: str) -> str:
    """Create minimal audit_dir with data/ directory."""
    data_dir = os.path.join(tmp, "data")
    os.makedirs(data_dir, exist_ok=True)
    return tmp


def _make_finding(
    finding_id: str = "F001",
    rule: str = "R07",
    severity: str = "MEDIUM",
    category: str = "typing",
    file: str = "src/foo.py",
    phase: int = 2,
    scanner: str = "grep-scanner",
    layer: str = "services",
    cross_cutting: bool = False,
    cross_cutting_group: str = "",
    current_code: str = "x: any = 1",
    fix_plan: str = "",
) -> dict:
    return {
        "id": finding_id,
        "rule": rule,
        "severity": severity,
        "category": category,
        "file": file,
        "line": 10,
        "snippet": "x = 1",
        "description": "Test finding",
        "explanation": "test",
        "search_pattern": "x = 1",
        "current_code": current_code,
        "fix_plan": fix_plan,
        "phase": phase,
        "effort": "low",
        "layer": layer,
        "scanner": scanner,
        "cross_cutting": cross_cutting,
        "cross_cutting_group": cross_cutting_group,
    }


def _write_findings(audit_dir: str, findings: list[dict]) -> None:
    """Write findings.jsonl."""
    path = os.path.join(audit_dir, "data", "findings.jsonl")
    with open(path, "w") as fh:
        for f in findings:
            fh.write(json.dumps(f) + "\n")


def _write_inventory(audit_dir: str, inventory: dict) -> None:
    """Write inventory.json."""
    path = os.path.join(audit_dir, "data", "inventory.json")
    with open(path, "w") as fh:
        json.dump(inventory, fh)


def _write_health(audit_dir: str, health: dict) -> None:
    """Write pipeline-health.json."""
    path = os.path.join(audit_dir, "data", "pipeline-health.json")
    with open(path, "w") as fh:
        json.dump(health, fh)


def _write_quality_gate(audit_dir: str, gate: dict) -> None:
    """Write quality-gate.json."""
    path = os.path.join(audit_dir, "data", "quality-gate.json")
    with open(path, "w") as fh:
        json.dump(gate, fh)


def _write_config(audit_dir: str, config: dict) -> None:
    """Write config.json."""
    path = os.path.join(audit_dir, "data", "config.json")
    with open(path, "w") as fh:
        json.dump(config, fh)


def _build_minimal_fixture(tmp: str) -> str:
    """Build a minimal but complete fixture with 5 findings."""
    audit_dir = _make_audit_dir(tmp)

    findings = [
        _make_finding("F001", rule="R07", severity="CRITICAL", category="typing",
                       file="src/a.py", phase=2, scanner="grep-scanner", layer="services"),
        _make_finding("F002", rule="R01", severity="HIGH", category="ssot-dry",
                       file="src/b.py", phase=3, scanner="jscpd", layer="services",
                       cross_cutting=True, cross_cutting_group="R01 across 3 files"),
        _make_finding("F003", rule="R01", severity="MEDIUM", category="ssot-dry",
                       file="src/c.py", phase=3, scanner="jscpd", layer="utils",
                       cross_cutting=True, cross_cutting_group="R01 across 3 files"),
        _make_finding("F004", rule="R05", severity="LOW", category="security",
                       file="src/d.py", phase=1, scanner="semgrep", layer="controllers",
                       current_code="", fix_plan=""),
        _make_finding("F005", rule="R09", severity="REVIEW", category="clean-code",
                       file="src/a.py", phase=5, scanner="grep-scanner", layer="services",
                       fix_plan="Remove dead code"),
    ]
    _write_findings(audit_dir, findings)

    _write_inventory(audit_dir, {
        "root": "backend",
        "stack": "python",
        "framework": "fastapi",
        "total_files": 50,
        "total_loc": 5000,
        "layers": {
            "services": {"files": ["src/a.py", "src/b.py"], "loc": 2000},
            "utils": {"files": ["src/c.py"], "loc": 500},
            "controllers": {"files": ["src/d.py"], "loc": 800},
        },
    })

    _write_health(audit_dir, {
        "timestamp": "2026-04-13T12:00:00+00:00",
        "tools_available": 4,
        "tools_succeeded": 3,
        "tools_failed": 1,
        "total_deterministic_findings": 10,
        "tool_results": [
            {"tool": "grep-scanner", "status": "success", "findings": 5, "duration_ms": 100},
            {"tool": "jscpd", "status": "success", "findings": 3, "duration_ms": 200},
            {"tool": "semgrep", "status": "success", "findings": 2, "duration_ms": 300},
            {"tool": "gitleaks", "status": "failed", "findings": 0, "duration_ms": 50},
        ],
    })

    _write_quality_gate(audit_dir, {
        "readiness_score": 85.0,
        "overall": "CONDITIONAL",
        "tiers": {"build": {"status": "PASS", "details": "0 errors"}},
        "summary": {"total_findings": 5, "critical": 1, "high": 1, "medium": 1, "low": 1},
    })

    return audit_dir


# -- Severity Counts ----------------------------------------------------------


class TestSeverityCounts:
    """Verify severity counts match actual findings."""

    def test_all_levels_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            for level in SEVERITY_LEVELS:
                assert level in stats["severity"]

    def test_counts_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            assert stats["severity"]["CRITICAL"] == 1
            assert stats["severity"]["HIGH"] == 1
            assert stats["severity"]["MEDIUM"] == 1
            assert stats["severity"]["LOW"] == 1
            assert stats["severity"]["REVIEW"] == 1
            assert stats["total_findings"] == 5

    def test_empty_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [])
            stats = compute_stats(audit_dir)
            assert stats["total_findings"] == 0
            for level in SEVERITY_LEVELS:
                assert stats["severity"][level] == 0


# -- Category Breakdown -------------------------------------------------------


class TestCategoryBreakdown:
    """Verify category breakdown is sorted by count desc."""

    def test_sorted_by_count_desc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            cats = stats["categories"]
            counts = [c["count"] for c in cats]
            assert counts == sorted(counts, reverse=True)

    def test_sub_severity_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            # ssot-dry has 2 findings: 1 HIGH + 1 MEDIUM
            ssot = next(c for c in stats["categories"] if c["name"] == "ssot-dry")
            assert ssot["count"] == 2
            assert ssot["high"] == 1
            assert ssot["medium"] == 1
            assert ssot["critical"] == 0

    def test_empty_categories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [])
            stats = compute_stats(audit_dir)
            assert stats["categories"] == []


# -- Enrichment Stats ---------------------------------------------------------


class TestEnrichmentStats:
    """Verify enrichment rate calculations."""

    def test_enrichment_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            enr = stats["enrichment"]
            # F001-F003: current_code="x: any = 1" (default) -> has_target_code
            # F004: current_code="" -> no target code, no fix_plan -> has_neither
            # F005: current_code="x: any = 1" (default) + fix_plan -> has both
            assert enr["has_target_code"] == 4
            assert enr["has_fix_plan"] == 1
            assert enr["has_either"] == 4
            assert enr["has_neither"] == 1
            assert enr["enrichment_rate_percent"] == 80.0

    def test_zero_findings_enrichment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [])
            stats = compute_stats(audit_dir)
            assert stats["enrichment"]["enrichment_rate_percent"] == 0.0
            assert stats["enrichment"]["has_neither"] == 0


# -- Layer Density Calculation ------------------------------------------------


class TestLayerBreakdown:
    """Verify layer density per KLOC."""

    def test_density_calculation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            # services layer: 3 findings (F001, F002, F005), 2000 LOC
            # density = 3 / 2.0 = 1.5
            services = next(l for l in stats["layers"] if l["name"] == "services")
            assert services["findings"] == 3
            assert services["loc"] == 2000
            assert services["density_per_kloc"] == 1.5

    def test_sorted_by_finding_count_desc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            finding_counts = [l["findings"] for l in stats["layers"]]
            assert finding_counts == sorted(finding_counts, reverse=True)

    def test_zero_loc_layer(self) -> None:
        """Layer with 0 LOC in inventory should have 0.0 density."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [_make_finding(layer="empty_layer")]
            _write_findings(audit_dir, findings)
            _write_inventory(audit_dir, {
                "root": "test",
                "stack": "python",
                "total_files": 1,
                "total_loc": 100,
                "layers": {"empty_layer": {"files": [], "loc": 0}},
            })
            stats = compute_stats(audit_dir)
            layer = next(l for l in stats["layers"] if l["name"] == "empty_layer")
            assert layer["density_per_kloc"] == 0.0


# -- Audit Date ---------------------------------------------------------------


class TestAuditDate:
    """Verify audit_date is current date."""

    def test_audit_date_is_today(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [])
            stats = compute_stats(audit_dir)
            assert stats["audit_date"] == date.today().isoformat()

    def test_generated_at_is_iso(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [])
            stats = compute_stats(audit_dir)
            # Should be a valid ISO timestamp
            assert "T" in stats["generated_at"]
            assert "+" in stats["generated_at"] or "Z" in stats["generated_at"]


# -- Missing Files Handling ---------------------------------------------------


class TestMissingFiles:
    """Verify graceful handling of missing data files."""

    def test_no_data_files_at_all(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            # No files written at all
            stats = compute_stats(audit_dir)
            assert stats["total_findings"] == 0
            assert stats["project_name"] == "unknown"
            assert stats["total_files"] == 0
            assert stats["total_loc"] == 0
            assert stats["quality_gate"] == {}
            assert stats["pipeline_health"] == {}
            assert stats["severity"]["CRITICAL"] == 0

    def test_only_findings_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [_make_finding()])
            stats = compute_stats(audit_dir)
            assert stats["total_findings"] == 1
            assert stats["project_name"] == "unknown"
            assert stats["quality_gate"] == {}

    def test_missing_findings_with_other_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory(audit_dir, {
                "root": "myproject",
                "stack": "go",
                "total_files": 200,
                "total_loc": 15000,
                "layers": {},
            })
            stats = compute_stats(audit_dir)
            assert stats["total_findings"] == 0
            assert stats["project_name"] == "myproject"
            assert stats["total_files"] == 200


# -- Phase Breakdown ----------------------------------------------------------


class TestPhaseBreakdown:
    """Verify phase breakdown with correct names and sorting."""

    def test_phase_names_from_ssot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            phases = {p["phase"]: p["name"] for p in stats["phases"]}
            assert phases[1] == "Security"
            assert phases[2] == "Typing Discipline"
            assert phases[3] == "SSOT / DRY"
            assert phases[5] == "Clean Code"

    def test_phases_sorted_by_number(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            phase_nums = [p["phase"] for p in stats["phases"]]
            assert phase_nums == sorted(phase_nums)

    def test_string_phase_handled(self) -> None:
        """Findings with string phase values should be parsed as int."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            f = _make_finding()
            f["phase"] = "3"
            _write_findings(audit_dir, [f])
            stats = compute_stats(audit_dir)
            assert stats["phases"][0]["phase"] == 3
            assert stats["phases"][0]["name"] == "SSOT / DRY"


# -- Cross-cutting Stats -----------------------------------------------------


class TestCrossCuttingStats:
    """Verify cross-cutting aggregation."""

    def test_cross_cutting_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            cc = stats["cross_cutting"]
            # 2 findings are cross-cutting out of 5 total
            assert cc["total_findings_in_groups"] == 2
            assert cc["total_groups"] == 1
            assert cc["percent_cross_cutting"] == 40.0


# -- Hotspots -----------------------------------------------------------------


class TestHotspots:
    """Verify top files by finding count."""

    def test_hotspot_ordering(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            # src/a.py has 2 findings (F001, F005), others have 1
            top = stats["hotspots"][0]
            assert top["file"] == "src/a.py"
            assert top["findings"] == 2


# -- Scanner & Rule Breakdown -------------------------------------------------


class TestScannerBreakdown:
    """Verify scanner and rule breakdowns."""

    def test_scanner_counts_sorted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            scanner_counts = [s["count"] for s in stats["scanners"]]
            assert scanner_counts == sorted(scanner_counts, reverse=True)
            # grep-scanner: F001 + F005 = 2, jscpd: F002 + F003 = 2, semgrep: F004 = 1
            grep = next(s for s in stats["scanners"] if s["name"] == "grep-scanner")
            assert grep["count"] == 2

    def test_rule_names_from_ssot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            r07 = next(r for r in stats["rules"] if r["rule"] == "R07")
            assert r07["name"] == "Strict Typing"
            assert r07["count"] == 1


# -- Config / Metadata --------------------------------------------------------


class TestConfigMetadata:
    """Verify config.json is metadata-only for stats generation."""

    def test_stack_and_framework_can_come_from_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            _write_config(audit_dir, {
                "stack": "typescript",
                "framework": "react",
            })
            stats = compute_stats(audit_dir)
            assert stats["stack"] == "typescript"
            assert stats["framework"] == "react"

    def test_counts_ignore_config_aggregates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            _write_config(audit_dir, {
                "total_findings": 60,
                "deduped_count": 5,
            })
            stats = compute_stats(audit_dir)
            assert stats["dedup_count"] == 0
            assert stats["total_raw_findings"] == 5  # same as total_findings


# -- write_stats (file output) ------------------------------------------------


class TestWriteStats:
    """Verify write_stats produces valid JSON file."""

    def test_writes_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            path = write_stats(audit_dir)
            assert os.path.isfile(path)
            assert path.endswith("audit-stats.json")
            with open(path) as fh:
                loaded = json.load(fh)
            assert loaded["total_findings"] == 5
            assert loaded["project_name"] == "backend"

    def test_creates_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # Start with empty tmp -- no data/ dir
            audit_dir = tmp
            path = write_stats(audit_dir)
            assert os.path.isfile(path)

    def test_round_trip_json(self) -> None:
        """Written JSON should be loadable and match computed stats."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            path = write_stats(audit_dir)
            with open(path) as fh:
                loaded = json.load(fh)
            # Compare key fields (timestamps differ)
            assert loaded["total_findings"] == stats["total_findings"]
            assert loaded["severity"] == stats["severity"]
            assert loaded["categories"] == stats["categories"]


# -- Quality Gate & Pipeline Health passthrough --------------------------------


class TestPassthrough:
    """Verify quality gate and health are passed through as-is."""

    def test_quality_gate_passthrough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            assert stats["quality_gate"]["readiness_score"] == 85.0
            assert stats["quality_gate"]["overall"] == "CONDITIONAL"

    def test_pipeline_health_passthrough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            assert stats["pipeline_health"]["tools_available"] == 4
            assert stats["pipeline_health"]["tools_succeeded"] == 3
            assert stats["pipeline_health"]["tools_failed"] == 1
            assert len(stats["pipeline_health"]["tool_results"]) == 4


# -- Project Metadata ---------------------------------------------------------


class TestProjectMetadata:
    """Verify project metadata extraction from inventory."""

    def test_metadata_from_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_minimal_fixture(tmp)
            stats = compute_stats(audit_dir)
            assert stats["project_name"] == "backend"
            assert stats["stack"] == "python"
            assert stats["framework"] == "fastapi"
            assert stats["total_files"] == 50
            assert stats["total_loc"] == 5000
