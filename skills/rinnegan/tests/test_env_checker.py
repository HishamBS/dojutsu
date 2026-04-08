"""Tests for env_checker -- verifies .env safety checks."""
from __future__ import annotations

import os
import sys
import textwrap

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from env_checker import (
    _check_committed_env,
    _check_duplicate_keys,
    _check_env_example_exists,
    _check_env_var_consistency,
    _parse_env_keys,
    check_env,
)

REQUIRED_FIELDS = {
    "rule", "severity", "category", "file", "line", "end_line",
    "snippet", "current_code", "description", "explanation",
    "search_pattern", "phase", "effort", "scanner", "confidence",
    "confidence_reason",
}


class TestCheckCommittedEnv:
    """Detect .env files committed to git."""

    def test_committed_env_emits_critical(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory,
    ) -> None:
        monkeypatch.setattr(
            "env_checker.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=".env\n"),
        )
        findings = list(_check_committed_env(str(tmp_path)))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R05"
        assert findings[0]["severity"] == "CRITICAL"
        assert findings[0]["category"] == "security"
        assert findings[0]["file"] == ".env"
        assert findings[0]["scanner"] == "env-check"
        for field in REQUIRED_FIELDS:
            assert field in findings[0], f"Missing field: {field}"

    def test_multiple_committed_env_files(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory,
    ) -> None:
        monkeypatch.setattr(
            "env_checker.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=".env\n.env.production\n"),
        )
        findings = list(_check_committed_env(str(tmp_path)))
        assert len(findings) == 2
        files = {f["file"] for f in findings}
        assert files == {".env", ".env.production"}

    def test_no_committed_env_emits_nothing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory,
    ) -> None:
        monkeypatch.setattr(
            "env_checker.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        findings = list(_check_committed_env(str(tmp_path)))
        assert findings == []

    def test_git_not_found_emits_nothing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory,
    ) -> None:
        def _raise(*args: object, **kwargs: object) -> None:
            raise FileNotFoundError("git not found")
        monkeypatch.setattr("env_checker.subprocess.run", _raise)
        findings = list(_check_committed_env(str(tmp_path)))
        assert findings == []


class TestCheckEnvExampleExists:
    """Detect missing .env.example when .env is gitignored."""

    def test_env_ignored_no_example_emits_medium(self, tmp_path: pytest.TempPathFactory) -> None:
        gitignore = tmp_path / ".gitignore"  # type: ignore[operator]
        gitignore.write_text(".env\nnode_modules/\n")
        findings = list(_check_env_example_exists(str(tmp_path)))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R12"
        assert findings[0]["severity"] == "MEDIUM"
        assert findings[0]["category"] == "data-integrity"

    def test_env_ignored_example_exists_emits_nothing(
        self, tmp_path: pytest.TempPathFactory,
    ) -> None:
        gitignore = tmp_path / ".gitignore"  # type: ignore[operator]
        gitignore.write_text(".env\n")
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("API_KEY=\n")
        findings = list(_check_env_example_exists(str(tmp_path)))
        assert findings == []

    def test_no_gitignore_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        findings = list(_check_env_example_exists(str(tmp_path)))
        assert findings == []

    def test_env_not_ignored_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        gitignore = tmp_path / ".gitignore"  # type: ignore[operator]
        gitignore.write_text("node_modules/\ndist/\n")
        findings = list(_check_env_example_exists(str(tmp_path)))
        assert findings == []


class TestCheckEnvVarConsistency:
    """Detect env vars in code but missing from .env.example."""

    def test_missing_var_emits_low(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("API_KEY=\nDB_HOST=\n")
        src = tmp_path / "app.ts"  # type: ignore[operator]
        src.write_text(textwrap.dedent("""\
            const key = process.env.API_KEY;
            const secret = process.env.SECRET_TOKEN;
        """))
        findings = list(_check_env_var_consistency(str(tmp_path)))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R12"
        assert findings[0]["severity"] == "LOW"
        assert "SECRET_TOKEN" in findings[0]["description"]

    def test_all_vars_present_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("API_KEY=\nDB_HOST=\n")
        src = tmp_path / "config.py"  # type: ignore[operator]
        src.write_text('url = os.getenv("DB_HOST")\n')
        findings = list(_check_env_var_consistency(str(tmp_path)))
        assert findings == []

    def test_no_env_example_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        src = tmp_path / "app.js"  # type: ignore[operator]
        src.write_text("const x = process.env.MISSING;\n")
        findings = list(_check_env_var_consistency(str(tmp_path)))
        assert findings == []

    def test_python_environ_patterns(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("KNOWN_VAR=\n")
        src = tmp_path / "main.py"  # type: ignore[operator]
        src.write_text(textwrap.dedent("""\
            import os
            a = os.environ["ALPHA"]
            b = os.environ.get("BETA")
            c = os.getenv("GAMMA")
        """))
        findings = list(_check_env_var_consistency(str(tmp_path)))
        names = {f["description"].split("'")[1] for f in findings}
        assert names == {"ALPHA", "BETA", "GAMMA"}

    def test_skips_node_modules(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("APP_KEY=\n")
        nm = tmp_path / "node_modules" / "lib"  # type: ignore[operator]
        nm.mkdir(parents=True)
        (nm / "index.js").write_text("process.env.HIDDEN_VAR;\n")
        findings = list(_check_env_var_consistency(str(tmp_path)))
        assert findings == []


class TestCheckDuplicateKeys:
    """Detect duplicate keys in .env.example."""

    def test_duplicate_key_emits_low(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("API_KEY=abc\nDB_HOST=localhost\nAPI_KEY=xyz\n")
        findings = list(_check_duplicate_keys(str(tmp_path)))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R09"
        assert findings[0]["severity"] == "LOW"
        assert findings[0]["category"] == "clean-code"
        assert "API_KEY" in findings[0]["description"]
        assert findings[0]["line"] == 3

    def test_no_duplicates_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("API_KEY=\nDB_HOST=\nSECRET=\n")
        findings = list(_check_duplicate_keys(str(tmp_path)))
        assert findings == []

    def test_comments_and_blanks_ignored(self, tmp_path: pytest.TempPathFactory) -> None:
        example = tmp_path / ".env.example"  # type: ignore[operator]
        example.write_text("# comment\n\nAPI_KEY=x\n# another comment\nDB=y\n")
        findings = list(_check_duplicate_keys(str(tmp_path)))
        assert findings == []

    def test_no_env_example_emits_nothing(self, tmp_path: pytest.TempPathFactory) -> None:
        findings = list(_check_duplicate_keys(str(tmp_path)))
        assert findings == []


class TestCheckEnv:
    """Integration: check_env aggregates all sub-checks."""

    def test_returns_list(self, tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "env_checker.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=""),
        )
        result = check_env(str(tmp_path), "typescript")
        assert isinstance(result, list)

    def test_all_findings_have_required_fields(
        self, tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "env_checker.subprocess.run",
            lambda *a, **kw: _mock_result(stdout=".env\n"),
        )
        gitignore = tmp_path / ".gitignore"  # type: ignore[operator]
        gitignore.write_text(".env\n")
        result = check_env(str(tmp_path), "python")
        assert len(result) >= 1
        for finding in result:
            for field in REQUIRED_FIELDS:
                assert field in finding, f"Missing field: {field}"


class TestParseEnvKeys:
    """Unit tests for _parse_env_keys helper."""

    def test_parses_keys(self, tmp_path: pytest.TempPathFactory) -> None:
        env_file = tmp_path / "test.env"  # type: ignore[operator]
        env_file.write_text("KEY_A=val\nKEY_B=\n# comment\n\nKEY_C=123\n")
        keys = _parse_env_keys(str(env_file))
        assert keys == {"KEY_A", "KEY_B", "KEY_C"}

    def test_empty_file(self, tmp_path: pytest.TempPathFactory) -> None:
        env_file = tmp_path / "empty.env"  # type: ignore[operator]
        env_file.write_text("")
        keys = _parse_env_keys(str(env_file))
        assert keys == set()


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
