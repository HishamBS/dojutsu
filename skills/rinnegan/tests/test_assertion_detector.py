"""Tests for assertion_detector -- verifies detection of assertion-free test
functions in Python (AST-based) and TypeScript (grep-based) test files."""
from __future__ import annotations

import os
import sys
import textwrap

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from assertion_detector import (
    _check_python_file,
    _check_typescript_file,
    _has_assertion,
    _is_python_test_file,
    _is_ts_test_file,
    _make_assertion_finding,
    _should_skip_dir,
    detect_assertion_free_tests,
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
# File detection helpers
# ---------------------------------------------------------------------------

class TestIsPythonTestFile:
    """Correctly identify Python test files."""

    def test_test_prefix(self) -> None:
        assert _is_python_test_file("test_utils.py") is True

    def test_test_suffix(self) -> None:
        assert _is_python_test_file("utils_test.py") is True

    def test_not_test_file(self) -> None:
        assert _is_python_test_file("utils.py") is False

    def test_not_python(self) -> None:
        assert _is_python_test_file("test_utils.js") is False


class TestIsTsTestFile:
    """Correctly identify TypeScript test files."""

    def test_test_ts(self) -> None:
        assert _is_ts_test_file("utils.test.ts") is True

    def test_spec_ts(self) -> None:
        assert _is_ts_test_file("utils.spec.ts") is True

    def test_test_tsx(self) -> None:
        assert _is_ts_test_file("App.test.tsx") is True

    def test_spec_tsx(self) -> None:
        assert _is_ts_test_file("App.spec.tsx") is True

    def test_not_test(self) -> None:
        assert _is_ts_test_file("utils.ts") is False


class TestShouldSkipDir:
    """Skip common non-test directories."""

    def test_node_modules(self) -> None:
        assert _should_skip_dir("node_modules") is True

    def test_git(self) -> None:
        assert _should_skip_dir(".git") is True

    def test_venv(self) -> None:
        assert _should_skip_dir(".venv") is True

    def test_nested_skip(self) -> None:
        assert _should_skip_dir(os.path.join("src", "node_modules", "pkg")) is True

    def test_normal_dir(self) -> None:
        assert _should_skip_dir("tests") is False

    def test_src_dir(self) -> None:
        assert _should_skip_dir("src") is False


# ---------------------------------------------------------------------------
# Python AST analysis
# ---------------------------------------------------------------------------

class TestCheckPythonFile:
    """AST-based detection of assertion-free Python tests."""

    def test_assert_statement_detected(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            def test_add():
                result = 1 + 1
                assert result == 2
        """)
        f = tmp_path / "test_math.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_math.py"))
        assert len(findings) == 0

    def test_no_assertion_detected(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            def test_smoke():
                result = 1 + 1
                print(result)
        """)
        f = tmp_path / "test_smoke.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_smoke.py"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R08"
        assert "test_smoke" in findings[0]["description"]

    def test_pytest_raises_detected(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            import pytest

            def test_error():
                with pytest.raises(ValueError):
                    int("not_a_number")
        """)
        f = tmp_path / "test_err.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_err.py"))
        assert len(findings) == 0

    def test_unittest_assert_detected(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            import unittest

            class TestFoo(unittest.TestCase):
                def test_bar(self):
                    self.assertEqual(1, 1)
        """)
        f = tmp_path / "test_foo.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_foo.py"))
        assert len(findings) == 0

    def test_mock_assert_detected(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            from unittest.mock import MagicMock

            def test_mock():
                mock = MagicMock()
                mock.do_thing()
                mock.do_thing.assert_called_once()
        """)
        f = tmp_path / "test_mock.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_mock.py"))
        assert len(findings) == 0

    def test_non_test_functions_ignored(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            def helper():
                pass

            def test_real():
                assert True
        """)
        f = tmp_path / "test_helper.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_helper.py"))
        assert len(findings) == 0

    def test_multiple_tests_mixed(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            def test_good():
                assert True

            def test_bad():
                x = 1

            def test_also_bad():
                pass
        """)
        f = tmp_path / "test_mixed.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_mixed.py"))
        assert len(findings) == 2
        names = [f["description"] for f in findings]
        assert any("test_bad" in n for n in names)
        assert any("test_also_bad" in n for n in names)

    def test_syntax_error_file_skipped(self, tmp_path: str) -> None:
        f = tmp_path / "test_broken.py"
        f.write_text("def test_x(:\n    pass\n")
        findings = list(_check_python_file(str(f), "test_broken.py"))
        assert len(findings) == 0

    def test_finding_has_all_required_fields(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            def test_empty():
                pass
        """)
        f = tmp_path / "test_fields.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_fields.py"))
        assert len(findings) == 1
        for field in REQUIRED_FIELDS:
            assert field in findings[0], f"Missing required field: {field}"

    def test_async_test_function(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            async def test_async_no_assert():
                result = await something()
        """)
        f = tmp_path / "test_async.py"
        f.write_text(code)
        findings = list(_check_python_file(str(f), "test_async.py"))
        assert len(findings) == 1
        assert "test_async_no_assert" in findings[0]["description"]


# ---------------------------------------------------------------------------
# TypeScript grep-based analysis
# ---------------------------------------------------------------------------

class TestCheckTypescriptFile:
    """Grep-based detection of assertion-free TypeScript tests."""

    def test_test_with_expect(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            import { describe, test, expect } from 'vitest';

            test('adds numbers', () => {
              const result = 1 + 1;
              expect(result).toBe(2);
            });
        """)
        f = tmp_path / "math.test.ts"
        f.write_text(code)
        findings = list(_check_typescript_file(str(f), "math.test.ts"))
        assert len(findings) == 0

    def test_test_without_expect(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            test('smoke test', () => {
              const result = 1 + 1;
              console.log(result);
            });
        """)
        f = tmp_path / "smoke.test.ts"
        f.write_text(code)
        findings = list(_check_typescript_file(str(f), "smoke.test.ts"))
        assert len(findings) == 1
        assert findings[0]["rule"] == "R08"
        assert "smoke test" in findings[0]["description"]

    def test_it_block_with_expect(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            describe('Utils', () => {
              it('should work', () => {
                expect(true).toBe(true);
              });
            });
        """)
        f = tmp_path / "utils.spec.ts"
        f.write_text(code)
        findings = list(_check_typescript_file(str(f), "utils.spec.ts"))
        assert len(findings) == 0

    def test_it_block_without_expect(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            describe('Utils', () => {
              it('should work', () => {
                const x = 1;
              });
            });
        """)
        f = tmp_path / "utils.spec.ts"
        f.write_text(code)
        findings = list(_check_typescript_file(str(f), "utils.spec.ts"))
        assert len(findings) == 1

    def test_mixed_blocks(self, tmp_path: str) -> None:
        code = textwrap.dedent("""\
            test('good test', () => {
              expect(1).toBe(1);
            });

            test('bad test', () => {
              console.log('no assertion');
            });

            test('another good', () => {
              expect(true).toBeTruthy();
            });
        """)
        f = tmp_path / "mixed.test.ts"
        f.write_text(code)
        findings = list(_check_typescript_file(str(f), "mixed.test.ts"))
        assert len(findings) == 1
        assert "bad test" in findings[0]["description"]

    def test_empty_file(self, tmp_path: str) -> None:
        f = tmp_path / "empty.test.ts"
        f.write_text("")
        findings = list(_check_typescript_file(str(f), "empty.test.ts"))
        assert len(findings) == 0


# ---------------------------------------------------------------------------
# Top-level detect function
# ---------------------------------------------------------------------------

class TestDetectAssertionFreeTests:
    """Integration tests for detect_assertion_free_tests."""

    def test_python_scan(self, tmp_path: str) -> None:
        test_dir = tmp_path / "tests"
        test_dir.mkdir()
        code = textwrap.dedent("""\
            def test_no_assert():
                x = 1
        """)
        (test_dir / "test_example.py").write_text(code)
        findings = detect_assertion_free_tests(str(tmp_path), "python")
        assert len(findings) == 1
        assert findings[0]["rule"] == "R08"

    def test_typescript_scan(self, tmp_path: str) -> None:
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        code = textwrap.dedent("""\
            test('no assertion', () => {
              const x = 1;
            });
        """)
        (src_dir / "app.test.ts").write_text(code)
        findings = detect_assertion_free_tests(str(tmp_path), "typescript")
        assert len(findings) == 1

    def test_java_returns_empty(self, tmp_path: str) -> None:
        findings = detect_assertion_free_tests(str(tmp_path), "java")
        assert len(findings) == 0

    def test_skips_node_modules(self, tmp_path: str) -> None:
        nm_dir = tmp_path / "node_modules" / "pkg"
        nm_dir.mkdir(parents=True)
        (nm_dir / "test_pkg.py").write_text("def test_x():\n    pass\n")
        findings = detect_assertion_free_tests(str(tmp_path), "python")
        assert len(findings) == 0


# ---------------------------------------------------------------------------
# Finding helper
# ---------------------------------------------------------------------------

class TestMakeAssertionFinding:
    """_make_assertion_finding produces correct schema."""

    def test_all_required_fields(self) -> None:
        finding = _make_assertion_finding(
            file="tests/test_app.py",
            line=5,
            test_name="test_something",
        )
        for field in REQUIRED_FIELDS:
            assert field in finding, f"Missing required field: {field}"

    def test_values_correct(self) -> None:
        finding = _make_assertion_finding(
            file="tests/test_app.py",
            line=10,
            test_name="test_foo",
        )
        assert finding["rule"] == "R08"
        assert finding["severity"] == "MEDIUM"
        assert finding["category"] == "build"
        assert finding["scanner"] == "assertion-detector"
        assert finding["line"] == 10
        assert "test_foo" in finding["description"]
