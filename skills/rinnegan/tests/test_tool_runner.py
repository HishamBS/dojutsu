#!/usr/bin/env python3
"""Tests for tool_runner -- verifies tool detection, finding normalization,
and mock output parsing for ESLint, Ruff, mypy, tsc, and Checkstyle."""
from __future__ import annotations

import json
import os
import sys

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from tool_runner import (
    ESLINT_DEFAULT,
    ESLINT_RULE_MAP,
    MYPY_DEFAULT,
    MYPY_RULE_MAP,
    RUFF_DEFAULT,
    RUFF_RULE_MAP,
    SEMGREP_SEVERITY_MAP,
    _make_finding,
    _map_eslint_rule,
    _phase_from_rule,
    _run_eslint,
    _run_mypy,
    _run_ruff,
    _run_tsc,
    detect_tools,
    run_tool,
)


# ---------------------------------------------------------------------------
# Required finding schema fields (from finding-schema.md)
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {
    "rule", "severity", "category", "file", "line", "end_line",
    "snippet", "current_code", "description", "explanation",
    "search_pattern", "phase", "effort", "scanner", "confidence",
    "confidence_reason",
}


class TestDetectTools:
    """detect_tools returns a list and handles missing tools gracefully."""

    def test_returns_list_for_known_stack(self) -> None:
        result = detect_tools("typescript", "/nonexistent/project")
        assert isinstance(result, list)

    def test_returns_list_for_unknown_stack(self) -> None:
        result = detect_tools("cobol", "/nonexistent/project")
        assert isinstance(result, list)
        # env-check is always available (language-agnostic, no binary needed)
        agnostic_tools = {"env-check"}
        non_agnostic = [t for t in result if t not in agnostic_tools]
        assert len(non_agnostic) == 0

    def test_returns_list_for_python_stack(self) -> None:
        result = detect_tools("python", "/nonexistent/project")
        assert isinstance(result, list)

    def test_returns_list_for_java_stack(self) -> None:
        result = detect_tools("java", "/nonexistent/project")
        assert isinstance(result, list)


class TestMakeFinding:
    """_make_finding produces all required fields matching the schema."""

    def test_all_required_fields_present(self) -> None:
        finding = _make_finding(
            rule="R14", severity="HIGH", category="build",
            file="src/app.ts", line=10,
            snippet="const x = 1;",
            description="Unused variable",
            scanner="eslint", confidence="high",
            confidence_reason="Deterministic: ESLint no-unused-vars",
            tool_rule_id="no-unused-vars",
        )
        for field in REQUIRED_FIELDS:
            assert field in finding, f"Missing required field: {field}"

    def test_field_values_correct(self) -> None:
        finding = _make_finding(
            rule="R07", severity="MEDIUM", category="typing",
            file="src/utils.ts", line=42,
            snippet="let val: any = null;",
            description="Explicit any type",
            scanner="tsc", confidence="high",
            confidence_reason="Deterministic: TypeScript TS2322",
            tool_rule_id="TS2322",
        )
        assert finding["rule"] == "R07"
        assert finding["severity"] == "MEDIUM"
        assert finding["category"] == "typing"
        assert finding["file"] == "src/utils.ts"
        assert finding["line"] == 42
        assert finding["end_line"] == 42
        assert finding["scanner"] == "tsc"
        assert finding["confidence"] == "high"
        assert finding["tool_rule_id"] == "TS2322"
        assert finding["cwe"] == []

    def test_cwe_passed_through(self) -> None:
        finding = _make_finding(
            rule="R05", severity="HIGH", category="security",
            file="app.py", line=5,
            snippet="eval(user_input)",
            description="Code injection via eval",
            scanner="semgrep", confidence="high",
            confidence_reason="Deterministic: Semgrep python.injection.eval",
            tool_rule_id="python.injection.eval",
            cwe=["CWE-94"],
        )
        assert finding["cwe"] == ["CWE-94"]

    def test_phase_derived_from_rule(self) -> None:
        finding = _make_finding(
            rule="R05", severity="CRITICAL", category="security",
            file="app.py", line=1,
            snippet="x", description="d",
            scanner="s", confidence="high",
            confidence_reason="r", tool_rule_id="t",
        )
        assert finding["phase"] == 1  # R05 -> phase 1

    def test_snippet_and_current_code_match(self) -> None:
        finding = _make_finding(
            rule="R14", severity="LOW", category="build",
            file="a.py", line=1,
            snippet="import os",
            description="unused import",
            scanner="ruff", confidence="high",
            confidence_reason="r", tool_rule_id="F401",
        )
        assert finding["snippet"] == finding["current_code"]


class TestPhaseFromRule:
    """_phase_from_rule maps rules to correct phases."""

    def test_known_rules(self) -> None:
        assert _phase_from_rule("R14") == 0
        assert _phase_from_rule("R05") == 1
        assert _phase_from_rule("R07") == 2
        assert _phase_from_rule("R01") == 3
        assert _phase_from_rule("R09") == 5
        assert _phase_from_rule("R04") == 6
        assert _phase_from_rule("R11") == 10

    def test_unknown_rule_defaults_to_5(self) -> None:
        assert _phase_from_rule("R99") == 5


class TestMapEslintRule:
    """ESLint rule mapping covers direct matches and wildcard prefixes."""

    def test_direct_match(self) -> None:
        assert _map_eslint_rule("no-unused-vars") == ("R14", "build", "MEDIUM")
        assert _map_eslint_rule("no-console") == ("R09", "clean-code", "MEDIUM")

    def test_wildcard_prefix(self) -> None:
        assert _map_eslint_rule("jsx-a11y/alt-text") == ("R16", "full-stack", "MEDIUM")
        assert _map_eslint_rule("jsx-a11y/anchor-has-content") == ("R16", "full-stack", "MEDIUM")

    def test_unknown_rule_returns_default(self) -> None:
        assert _map_eslint_rule("some-custom-rule") == ESLINT_DEFAULT


class TestNormalizeEslintOutput:
    """Parse mock ESLint JSON output into normalized findings."""

    def test_single_file_single_message(self, monkeypatch: pytest.MonkeyPatch) -> None:
        eslint_output = json.dumps([{
            "filePath": "/project/src/app.tsx",
            "messages": [{
                "ruleId": "no-unused-vars",
                "severity": 2,
                "message": "'x' is assigned but never used.",
                "line": 5,
                "column": 7,
                "endLine": 5,
                "endColumn": 8,
            }],
        }])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=eslint_output),
        )
        findings = list(_run_eslint("/project", "typescript"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R14"
        assert findings[0]["file"] == "src/app.tsx"
        assert findings[0]["line"] == 5
        assert findings[0]["scanner"] == "eslint"
        assert findings[0]["confidence"] == "high"
        assert findings[0]["category"] == "build"

    def test_empty_output_yields_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        findings = list(_run_eslint("/project", "typescript"))
        assert findings == []

    def test_multiple_files_multiple_messages(self, monkeypatch: pytest.MonkeyPatch) -> None:
        eslint_output = json.dumps([
            {
                "filePath": "/project/src/a.ts",
                "messages": [
                    {"ruleId": "no-console", "severity": 1, "message": "Unexpected console statement.", "line": 3, "column": 1, "endLine": 3, "endColumn": 20},
                    {"ruleId": "@typescript-eslint/no-explicit-any", "severity": 2, "message": "Unexpected any.", "line": 7, "column": 5, "endLine": 7, "endColumn": 8},
                ],
            },
            {
                "filePath": "/project/src/b.ts",
                "messages": [
                    {"ruleId": "no-unused-vars", "severity": 2, "message": "'y' unused.", "line": 1, "column": 1, "endLine": 1, "endColumn": 2},
                ],
            },
        ])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=eslint_output),
        )
        findings = list(_run_eslint("/project", "typescript"))
        assert len(findings) == 3
        assert findings[0]["scanner"] == "eslint"
        assert findings[1]["rule"] == "R07"  # no-explicit-any
        assert findings[2]["file"] == "src/b.ts"


class TestNormalizeRuffOutput:
    """Parse mock Ruff JSON output into normalized findings."""

    def test_single_finding(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ruff_output = json.dumps([{
            "code": "F401",
            "message": "`os` imported but unused",
            "filename": "/project/app/main.py",
            "location": {"row": 1, "column": 1},
            "end_location": {"row": 1, "column": 10},
        }])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=ruff_output),
        )
        findings = list(_run_ruff("/project", "python"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R14"
        assert findings[0]["severity"] == "LOW"
        assert findings[0]["scanner"] == "ruff"
        assert findings[0]["tool_rule_id"] == "F401"
        assert findings[0]["file"] == "app/main.py"

    def test_security_rule_maps_correctly(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ruff_output = json.dumps([{
            "code": "S608",
            "message": "Possible SQL injection",
            "filename": "/project/db.py",
            "location": {"row": 10, "column": 1},
            "end_location": {"row": 10, "column": 20},
        }])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=ruff_output),
        )
        findings = list(_run_ruff("/project", "python"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R05"
        assert findings[0]["severity"] == "HIGH"
        assert findings[0]["category"] == "security"

    def test_empty_output(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        findings = list(_run_ruff("/project", "python"))
        assert findings == []

    def test_unknown_ruff_code_uses_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ruff_output = json.dumps([{
            "code": "ZZZZ999",
            "message": "Unknown rule",
            "filename": "/project/x.py",
            "location": {"row": 1, "column": 1},
            "end_location": {"row": 1, "column": 5},
        }])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=ruff_output),
        )
        findings = list(_run_ruff("/project", "python"))
        assert len(findings) == 1
        assert findings[0]["rule"] == RUFF_DEFAULT[0]
        assert findings[0]["category"] == RUFF_DEFAULT[1]


class TestNormalizeMypyOutput:
    """Parse mock mypy JSONL output into normalized findings."""

    def test_single_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mypy_line = json.dumps({
            "file": "app/service.py",
            "line": 25,
            "column": 10,
            "message": "Incompatible types in assignment",
            "severity": "error",
            "code": "assignment",
        })
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=mypy_line),
        )
        findings = list(_run_mypy("/project", "python"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R07"
        assert findings[0]["category"] == "typing"
        assert findings[0]["file"] == "app/service.py"
        assert findings[0]["line"] == 25
        assert findings[0]["scanner"] == "mypy"

    def test_notes_are_skipped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        lines = "\n".join([
            json.dumps({"file": "a.py", "line": 1, "message": "Found error", "severity": "error", "code": "arg-type"}),
            json.dumps({"file": "a.py", "line": 1, "message": "See definition", "severity": "note", "code": ""}),
        ])
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=lines),
        )
        findings = list(_run_mypy("/project", "python"))
        assert len(findings) == 1

    def test_empty_output(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        findings = list(_run_mypy("/project", "python"))
        assert findings == []

    def test_invalid_json_lines_skipped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        lines = "not valid json\n" + json.dumps({
            "file": "b.py", "line": 5, "message": "err", "severity": "error", "code": "return-value",
        })
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=lines),
        )
        findings = list(_run_mypy("/project", "python"))
        assert len(findings) == 1
        assert findings[0]["tool_rule_id"] == "return-value"


class TestNormalizeTscOutput:
    """Parse mock tsc text output into normalized findings."""

    def test_type_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        tsc_output = "src/utils.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=tsc_output),
        )
        findings = list(_run_tsc("/project", "typescript"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R07"
        assert findings[0]["category"] == "typing"
        assert findings[0]["file"] == "src/utils.ts"
        assert findings[0]["line"] == 12
        assert findings[0]["severity"] == "HIGH"
        assert findings[0]["tool_rule_id"] == "TS2322"

    def test_non_type_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        tsc_output = "src/index.ts(3,1): error TS1005: ';' expected.\n"
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=tsc_output),
        )
        findings = list(_run_tsc("/project", "typescript"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R14"
        assert findings[0]["category"] == "build"

    def test_empty_output(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        findings = list(_run_tsc("/project", "typescript"))
        assert findings == []

    def test_multiple_errors(self, monkeypatch: pytest.MonkeyPatch) -> None:
        tsc_output = (
            "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.\n"
            "src/b.ts(10,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n"
        )
        monkeypatch.setattr(
            "tool_runner.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=tsc_output),
        )
        findings = list(_run_tsc("/project", "typescript"))
        assert len(findings) == 2


class TestRunTool:
    """run_tool dispatches to the correct runner and handles errors."""

    def test_unknown_tool_returns_empty(self) -> None:
        result = run_tool("nonexistent_tool", "/project", "typescript")
        assert result == []

    def test_exception_returns_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _raise(*args: str, **kwargs: str) -> None:
            raise RuntimeError("tool crashed")
        monkeypatch.setattr("tool_runner._run_eslint", _raise)
        result = run_tool("eslint", "/project", "typescript")
        assert result == []


class TestRuleMaps:
    """Verify rule map dictionaries have correct value types."""

    def test_eslint_map_values(self) -> None:
        for rule_id, (r_rule, category, severity) in ESLINT_RULE_MAP.items():
            assert r_rule.startswith("R"), f"Invalid rule: {r_rule}"
            assert isinstance(category, str)
            assert severity in ("LOW", "MEDIUM", "HIGH", "CRITICAL")

    def test_ruff_map_values(self) -> None:
        for code, (r_rule, category, severity) in RUFF_RULE_MAP.items():
            assert r_rule.startswith("R"), f"Invalid rule: {r_rule}"
            assert severity in ("LOW", "MEDIUM", "HIGH", "CRITICAL")

    def test_mypy_map_values(self) -> None:
        for code, (r_rule, category, severity) in MYPY_RULE_MAP.items():
            assert r_rule.startswith("R"), f"Invalid rule: {r_rule}"
            assert severity in ("LOW", "MEDIUM", "HIGH", "CRITICAL")

    def test_semgrep_severity_map(self) -> None:
        for key, val in SEMGREP_SEVERITY_MAP.items():
            assert val in ("LOW", "MEDIUM", "HIGH", "CRITICAL")


# ---------------------------------------------------------------------------
# Helper: mock subprocess result
# ---------------------------------------------------------------------------

class _MockResult:
    """Minimal mock for subprocess.CompletedProcess."""
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _mock_result(stdout: str = "", stderr: str = "", returncode: int = 0) -> _MockResult:
    return _MockResult(stdout=stdout, stderr=stderr, returncode=returncode)
