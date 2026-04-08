"""Detect test functions that contain zero assertions.

Uses Python's ast module for Python test files and grep-style parsing for
TypeScript test files. Assertion-free tests are smoke tests at best and
provide false confidence in code correctness.
"""
from __future__ import annotations

import ast
import os
import re
from typing import Iterator


# -- Assertion-detecting AST node names for Python ----------------------------

_PYTEST_ASSERT_CALLS: frozenset[str] = frozenset({
    "raises",  # pytest.raises(...)
})

_UNITTEST_ASSERT_PREFIXES: tuple[str, ...] = (
    "assert",       # self.assertEqual, self.assertTrue, etc.
    "fail",         # self.fail(...)
)

_MOCK_ASSERT_PREFIXES: tuple[str, ...] = (
    "assert_called",
    "assert_not_called",
    "assert_called_once",
    "assert_called_with",
    "assert_called_once_with",
    "assert_any_call",
    "assert_has_calls",
)


def detect_assertion_free_tests(
    project_dir: str,
    stack: str,
) -> list[dict[str, str | int | list[str]]]:
    """Scan test files for functions/blocks with no assertions.

    Args:
        project_dir: Root directory of the project being audited.
        stack: One of "typescript", "python", or "java".

    Returns:
        List of findings in standard dojutsu format.
    """
    findings: list[dict[str, str | int | list[str]]] = []

    if stack == "python":
        findings.extend(_scan_python_tests(project_dir))
    elif stack == "typescript":
        findings.extend(_scan_typescript_tests(project_dir))

    return findings


# -- Python: AST-based analysis -----------------------------------------------

def _scan_python_tests(project_dir: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Walk project for Python test files and check each test function."""
    for dirpath, _dirnames, filenames in os.walk(project_dir):
        # Skip common non-test directories
        rel_dir = os.path.relpath(dirpath, project_dir)
        if _should_skip_dir(rel_dir):
            continue

        for filename in filenames:
            if not _is_python_test_file(filename):
                continue
            filepath = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(filepath, project_dir)
            yield from _check_python_file(filepath, rel_path)


def _is_python_test_file(filename: str) -> bool:
    """Return True if filename looks like a Python test file."""
    if not filename.endswith(".py"):
        return False
    return filename.startswith("test_") or filename.endswith("_test.py")


def _should_skip_dir(rel_dir: str) -> bool:
    """Return True if directory should be skipped during scanning."""
    skip_parts = {
        "node_modules", ".git", "__pycache__", ".venv", "venv",
        ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
    }
    parts = set(rel_dir.split(os.sep))
    return bool(parts & skip_parts)


def _check_python_file(
    filepath: str,
    rel_path: str,
) -> Iterator[dict[str, str | int | list[str]]]:
    """Parse a single Python file and yield findings for assertion-free tests."""
    try:
        with open(filepath, encoding="utf-8") as fh:
            source = fh.read()
    except (OSError, UnicodeDecodeError):
        return

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError:
        return

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith("test_"):
            continue
        if not _has_assertion(node):
            yield _make_assertion_finding(
                file=rel_path,
                line=node.lineno,
                test_name=node.name,
            )


def _has_assertion(func_node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Return True if the function body contains at least one assertion.

    Recognized assertion patterns:
    - ``assert`` statements (ast.Assert)
    - ``pytest.raises(...)`` calls
    - ``self.assert*()`` calls (unittest style)
    - ``mock.assert_*()`` calls
    """
    for node in ast.walk(func_node):
        # Plain assert statement
        if isinstance(node, ast.Assert):
            return True

        # Function/method calls
        if isinstance(node, ast.Call):
            if _is_assert_call(node):
                return True

    return False


def _is_assert_call(call_node: ast.Call) -> bool:
    """Return True if call_node represents an assertion call."""
    func = call_node.func

    # pytest.raises(...) or similar
    if isinstance(func, ast.Attribute):
        attr_name: str = func.attr

        # self.assert*, self.fail*
        if isinstance(func.value, ast.Name) and func.value.id == "self":
            if attr_name.startswith(_UNITTEST_ASSERT_PREFIXES):
                return True

        # pytest.raises
        if isinstance(func.value, ast.Name) and func.value.id == "pytest":
            if attr_name in _PYTEST_ASSERT_CALLS:
                return True

        # mock.assert_called*, any_obj.assert_called*
        for prefix in _MOCK_ASSERT_PREFIXES:
            if attr_name.startswith(prefix):
                return True

    return False


# -- TypeScript: grep-based analysis ------------------------------------------

_TS_TEST_BLOCK_RE = re.compile(
    r"""(?:test|it)\s*\(\s*(?:['"`])""",
    re.MULTILINE,
)

_TS_EXPECT_RE = re.compile(r"""expect\s*\(""")


def _scan_typescript_tests(project_dir: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Walk project for TypeScript test files and check for expect() calls."""
    for dirpath, _dirnames, filenames in os.walk(project_dir):
        rel_dir = os.path.relpath(dirpath, project_dir)
        if _should_skip_dir(rel_dir):
            continue

        for filename in filenames:
            if not _is_ts_test_file(filename):
                continue
            filepath = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(filepath, project_dir)
            yield from _check_typescript_file(filepath, rel_path)


def _is_ts_test_file(filename: str) -> bool:
    """Return True if filename looks like a TypeScript test file."""
    return filename.endswith((".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"))


def _check_typescript_file(
    filepath: str,
    rel_path: str,
) -> Iterator[dict[str, str | int | list[str]]]:
    """Parse a TypeScript test file and yield findings for assertion-free blocks."""
    try:
        with open(filepath, encoding="utf-8") as fh:
            content = fh.read()
    except (OSError, UnicodeDecodeError):
        return

    lines = content.split("\n")

    # Find all test block start positions (line numbers)
    test_blocks: list[tuple[int, str]] = []
    for i, line in enumerate(lines, start=1):
        match = _TS_TEST_BLOCK_RE.search(line)
        if match:
            # Extract test name from the line
            name_match = re.search(r"""(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]""", line)
            test_name = name_match.group(1) if name_match else f"anonymous_test_line_{i}"
            test_blocks.append((i, test_name))

    # For each test block, check if expect() appears before the next test block
    for idx, (line_num, test_name) in enumerate(test_blocks):
        # Determine the range: from this block start to next block start (or EOF)
        end_line = test_blocks[idx + 1][0] if idx + 1 < len(test_blocks) else len(lines) + 1
        block_content = "\n".join(lines[line_num - 1:end_line - 1])

        if not _TS_EXPECT_RE.search(block_content):
            yield _make_assertion_finding(
                file=rel_path,
                line=line_num,
                test_name=test_name,
            )


# -- Shared helpers ------------------------------------------------------------

def _make_assertion_finding(
    *,
    file: str,
    line: int,
    test_name: str,
) -> dict[str, str | int | list[str]]:
    """Create a finding dict matching the dojutsu findings.jsonl schema."""
    description = f"Test '{test_name}' has no assertions"
    return {
        "rule": "R08",
        "severity": "MEDIUM",
        "category": "build",
        "file": file,
        "line": line,
        "end_line": line,
        "snippet": description,
        "current_code": description,
        "description": description,
        "explanation": description,
        "search_pattern": "",
        "phase": 9,
        "effort": "low",
        "scanner": "assertion-detector",
        "confidence": "high",
        "confidence_reason": "Deterministic: AST/grep assertion analysis",
        "tool_rule_id": "no-assertions",
        "cwe": [],
    }
