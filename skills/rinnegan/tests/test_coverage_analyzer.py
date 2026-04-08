"""Tests for coverage_analyzer -- verifies parsing of Istanbul, coverage.py,
and JaCoCo coverage reports into normalized R08 findings."""
from __future__ import annotations

import json
import os
import sys
import textwrap

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from coverage_analyzer import (
    _make_coverage_finding,
    _no_report_finding,
    _parse_coverage_py,
    _parse_istanbul,
    _parse_jacoco,
    analyze_coverage,
)

# ---------------------------------------------------------------------------
# Required finding schema fields
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {
    "rule", "severity", "category", "file", "line", "end_line",
    "snippet", "current_code", "description", "explanation",
    "search_pattern", "phase", "effort", "scanner", "confidence",
    "confidence_reason",
}


# ---------------------------------------------------------------------------
# analyze_coverage: top-level dispatcher
# ---------------------------------------------------------------------------

class TestAnalyzeCoverage:
    """Top-level function dispatches to the correct parser."""

    def test_unknown_stack_returns_no_report(self, tmp_path: str) -> None:
        findings = analyze_coverage(str(tmp_path), "cobol")
        assert len(findings) == 1
        assert "No test coverage report found" in findings[0]["description"]

    def test_missing_report_returns_no_report(self, tmp_path: str) -> None:
        findings = analyze_coverage(str(tmp_path), "typescript")
        assert len(findings) == 1
        assert "No test coverage report found" in findings[0]["description"]

    def test_typescript_with_report(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        report = {
            "/project/src/utils.ts": {
                "fnMap": {
                    "0": {"name": "add", "line": 1, "loc": {"start": {"line": 1}}},
                    "1": {"name": "subtract", "line": 5, "loc": {"start": {"line": 5}}},
                },
                "f": {"0": 3, "1": 0},
            }
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        findings = analyze_coverage(str(tmp_path), "typescript")
        assert len(findings) == 1
        assert "subtract" in findings[0]["description"]


# ---------------------------------------------------------------------------
# Istanbul / c8 parser
# ---------------------------------------------------------------------------

class TestParseIstanbul:
    """Parse coverage/coverage-final.json."""

    def test_no_file_returns_none(self, tmp_path: str) -> None:
        result = _parse_istanbul(str(tmp_path))
        assert result is None

    def test_invalid_json_returns_none(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        (cov_dir / "coverage-final.json").write_text("{invalid json")
        result = _parse_istanbul(str(tmp_path))
        assert result is None

    def test_all_covered_returns_empty(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        report = {
            "src/app.ts": {
                "fnMap": {"0": {"name": "main", "line": 1}},
                "f": {"0": 5},
            }
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        result = _parse_istanbul(str(tmp_path))
        assert result is not None
        assert len(result) == 0

    def test_uncovered_function_detected(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        report = {
            "src/utils.ts": {
                "fnMap": {
                    "0": {"name": "usedFn", "line": 1, "loc": {"start": {"line": 1}}},
                    "1": {"name": "unusedFn", "line": 10, "loc": {"start": {"line": 10}}},
                },
                "f": {"0": 2, "1": 0},
            }
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        result = _parse_istanbul(str(tmp_path))
        assert result is not None
        assert len(result) == 1
        assert result[0]["rule"] == "R08"
        assert result[0]["line"] == 10
        assert "unusedFn" in result[0]["description"]
        assert result[0]["scanner"] == "coverage-analyzer"

    def test_multiple_files_multiple_uncovered(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        report = {
            "src/a.ts": {
                "fnMap": {"0": {"name": "fn_a", "line": 1}},
                "f": {"0": 0},
            },
            "src/b.ts": {
                "fnMap": {"0": {"name": "fn_b", "line": 5}},
                "f": {"0": 0},
            },
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        result = _parse_istanbul(str(tmp_path))
        assert result is not None
        assert len(result) == 2

    def test_finding_has_all_required_fields(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        report = {
            "src/x.ts": {
                "fnMap": {"0": {"name": "uncov", "line": 3}},
                "f": {"0": 0},
            }
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        result = _parse_istanbul(str(tmp_path))
        assert result is not None
        assert len(result) == 1
        for field in REQUIRED_FIELDS:
            assert field in result[0], f"Missing required field: {field}"

    def test_absolute_path_relativized(self, tmp_path: str) -> None:
        cov_dir = tmp_path / "coverage"
        cov_dir.mkdir()
        abs_path = str(tmp_path / "src" / "abs.ts")
        report = {
            abs_path: {
                "fnMap": {"0": {"name": "fn", "line": 1}},
                "f": {"0": 0},
            }
        }
        (cov_dir / "coverage-final.json").write_text(json.dumps(report))
        result = _parse_istanbul(str(tmp_path))
        assert result is not None
        assert not os.path.isabs(result[0]["file"])


# ---------------------------------------------------------------------------
# coverage.py parser
# ---------------------------------------------------------------------------

class TestParseCoveragePy:
    """Parse coverage.json."""

    def test_no_file_returns_none(self, tmp_path: str) -> None:
        result = _parse_coverage_py(str(tmp_path))
        assert result is None

    def test_invalid_json_returns_none(self, tmp_path: str) -> None:
        (tmp_path / "coverage.json").write_text("not json {{{")
        result = _parse_coverage_py(str(tmp_path))
        assert result is None

    def test_all_covered_returns_empty(self, tmp_path: str) -> None:
        report = {
            "files": {
                "app/main.py": {
                    "functions": {
                        "main": {"summary": {"percent_covered": 100.0}, "line": 1},
                    }
                }
            }
        }
        (tmp_path / "coverage.json").write_text(json.dumps(report))
        result = _parse_coverage_py(str(tmp_path))
        assert result is not None
        assert len(result) == 0

    def test_uncovered_function_detected(self, tmp_path: str) -> None:
        report = {
            "files": {
                "app/utils.py": {
                    "functions": {
                        "used_fn": {"summary": {"percent_covered": 85.0}, "line": 1},
                        "unused_fn": {"summary": {"percent_covered": 0.0}, "line": 20},
                    }
                }
            }
        }
        (tmp_path / "coverage.json").write_text(json.dumps(report))
        result = _parse_coverage_py(str(tmp_path))
        assert result is not None
        assert len(result) == 1
        assert result[0]["rule"] == "R08"
        assert "unused_fn" in result[0]["description"]
        assert result[0]["line"] == 20

    def test_multiple_files(self, tmp_path: str) -> None:
        report = {
            "files": {
                "a.py": {
                    "functions": {
                        "fn_a": {"summary": {"percent_covered": 0.0}, "line": 1},
                    }
                },
                "b.py": {
                    "functions": {
                        "fn_b": {"summary": {"percent_covered": 0.0}, "line": 10},
                    }
                },
            }
        }
        (tmp_path / "coverage.json").write_text(json.dumps(report))
        result = _parse_coverage_py(str(tmp_path))
        assert result is not None
        assert len(result) == 2


# ---------------------------------------------------------------------------
# JaCoCo parser
# ---------------------------------------------------------------------------

class TestParseJacoco:
    """Parse target/site/jacoco/jacoco.xml."""

    def test_no_file_returns_none(self, tmp_path: str) -> None:
        result = _parse_jacoco(str(tmp_path))
        assert result is None

    def test_invalid_xml_returns_none(self, tmp_path: str) -> None:
        jacoco_dir = tmp_path / "target" / "site" / "jacoco"
        jacoco_dir.mkdir(parents=True)
        (jacoco_dir / "jacoco.xml").write_text("<not valid xml")
        result = _parse_jacoco(str(tmp_path))
        assert result is None

    def test_all_covered_returns_empty(self, tmp_path: str) -> None:
        jacoco_dir = tmp_path / "target" / "site" / "jacoco"
        jacoco_dir.mkdir(parents=True)
        xml = textwrap.dedent("""\
            <?xml version="1.0" encoding="UTF-8"?>
            <report name="test">
              <package name="com/example">
                <class name="com/example/App" sourcefilename="App.java">
                  <method name="main" line="5">
                    <counter type="METHOD" missed="0" covered="1"/>
                  </method>
                </class>
              </package>
            </report>
        """)
        (jacoco_dir / "jacoco.xml").write_text(xml)
        result = _parse_jacoco(str(tmp_path))
        assert result is not None
        assert len(result) == 0

    def test_uncovered_method_detected(self, tmp_path: str) -> None:
        jacoco_dir = tmp_path / "target" / "site" / "jacoco"
        jacoco_dir.mkdir(parents=True)
        xml = textwrap.dedent("""\
            <?xml version="1.0" encoding="UTF-8"?>
            <report name="test">
              <package name="com/example">
                <class name="com/example/Utils" sourcefilename="Utils.java">
                  <method name="process" line="10">
                    <counter type="METHOD" missed="1" covered="0"/>
                  </method>
                  <method name="validate" line="25">
                    <counter type="METHOD" missed="0" covered="1"/>
                  </method>
                </class>
              </package>
            </report>
        """)
        (jacoco_dir / "jacoco.xml").write_text(xml)
        result = _parse_jacoco(str(tmp_path))
        assert result is not None
        assert len(result) == 1
        assert result[0]["rule"] == "R08"
        assert "process" in result[0]["description"]
        assert result[0]["line"] == 10

    def test_multiple_uncovered_methods(self, tmp_path: str) -> None:
        jacoco_dir = tmp_path / "target" / "site" / "jacoco"
        jacoco_dir.mkdir(parents=True)
        xml = textwrap.dedent("""\
            <?xml version="1.0" encoding="UTF-8"?>
            <report name="test">
              <package name="com/example">
                <class name="com/example/A" sourcefilename="A.java">
                  <method name="foo" line="1">
                    <counter type="METHOD" missed="1" covered="0"/>
                  </method>
                </class>
                <class name="com/example/B" sourcefilename="B.java">
                  <method name="bar" line="5">
                    <counter type="METHOD" missed="1" covered="0"/>
                  </method>
                </class>
              </package>
            </report>
        """)
        (jacoco_dir / "jacoco.xml").write_text(xml)
        result = _parse_jacoco(str(tmp_path))
        assert result is not None
        assert len(result) == 2


# ---------------------------------------------------------------------------
# Finding helpers
# ---------------------------------------------------------------------------

class TestMakeCoverageFinding:
    """_make_coverage_finding produces correct schema."""

    def test_all_required_fields(self) -> None:
        finding = _make_coverage_finding(
            file="src/app.ts", line=10,
            description="Function 'foo' has zero test coverage",
        )
        for field in REQUIRED_FIELDS:
            assert field in finding, f"Missing required field: {field}"

    def test_values_correct(self) -> None:
        finding = _make_coverage_finding(
            file="src/app.ts", line=42,
            description="Function 'bar' has zero test coverage",
        )
        assert finding["rule"] == "R08"
        assert finding["severity"] == "MEDIUM"
        assert finding["category"] == "build"
        assert finding["scanner"] == "coverage-analyzer"
        assert finding["line"] == 42
        assert finding["file"] == "src/app.ts"


class TestNoReportFinding:
    """_no_report_finding returns a valid advisory finding."""

    def test_has_all_required_fields(self) -> None:
        finding = _no_report_finding()
        for field in REQUIRED_FIELDS:
            assert field in finding, f"Missing required field: {field}"

    def test_description_content(self) -> None:
        finding = _no_report_finding()
        assert "No test coverage report found" in finding["description"]
        assert finding["severity"] == "MEDIUM"
        assert finding["rule"] == "R08"
