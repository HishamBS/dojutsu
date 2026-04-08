"""Environment file consistency checker.

Deterministic checks for .env safety: committed secrets, missing .env.example,
env var drift between code and .env.example, and duplicate keys.
"""
from __future__ import annotations

import os
import re
import subprocess
from typing import Iterator


# Patterns that extract environment variable names from source code
_ENV_PATTERNS: list[re.Pattern[str]] = [
    # Match both UPPER_CASE and camelCase env vars (e.g., process.env.API_KEY, process.env.apiUrl)
    re.compile(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)"),
    re.compile(r'os\.environ\["([A-Za-z_][A-Za-z0-9_]*)"\]'),
    re.compile(r"os\.environ\['([A-Za-z_][A-Za-z0-9_]*)'\]"),
    re.compile(r'os\.getenv\("([A-Za-z_][A-Za-z0-9_]*)"'),
    re.compile(r"os\.getenv\('([A-Za-z_][A-Za-z0-9_]*)'"),
    re.compile(r'os\.environ\.get\("([A-Za-z_][A-Za-z0-9_]*)"'),
    re.compile(r"os\.environ\.get\('([A-Za-z_][A-Za-z0-9_]*)'"),
]

# Files to check for committed env secrets
_ENV_FILES: list[str] = [".env", ".env.local", ".env.production"]

# Source file extensions to scan for env var references
_SOURCE_EXTENSIONS: frozenset[str] = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
})


def check_env(project_dir: str, stack: str) -> list[dict[str, str | int | list[str]]]:
    """Run all env consistency checks and return findings in standard format.

    Args:
        project_dir: Root directory of the project to check.
        stack: Detected project stack (typescript, python, java).

    Returns:
        List of finding dicts matching the dojutsu findings.jsonl schema.
    """
    findings: list[dict[str, str | int | list[str]]] = []
    findings.extend(_check_committed_env(project_dir))
    findings.extend(_check_env_example_exists(project_dir))
    findings.extend(_check_env_var_consistency(project_dir))
    findings.extend(_check_duplicate_keys(project_dir))
    return findings


def _check_committed_env(project_dir: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Check if .env files are tracked by git (CRITICAL R05)."""
    try:
        result = subprocess.run(
            ["git", "ls-files"] + _ENV_FILES,
            capture_output=True, text=True, cwd=project_dir, timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return
    for tracked_file in result.stdout.strip().splitlines():
        tracked_file = tracked_file.strip()
        if not tracked_file:
            continue
        yield _make_env_finding(
            rule="R05",
            severity="CRITICAL",
            category="security",
            file=tracked_file,
            line=1,
            description=(
                f"Environment file '{tracked_file}' is committed to git. "
                "This may expose secrets. Add it to .gitignore and remove from tracking."
            ),
            scanner="env-check",
            confidence="high",
            confidence_reason=f"Deterministic: git ls-files shows '{tracked_file}' is tracked",
        )


def _check_env_example_exists(project_dir: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Check if .env.example exists when .env is gitignored (MEDIUM R12)."""
    gitignore_path = os.path.join(project_dir, ".gitignore")
    if not os.path.isfile(gitignore_path):
        return
    with open(gitignore_path) as f:
        gitignore_content = f.read()
    env_ignored = any(
        line.strip() in (".env", ".env*", ".env.*")
        for line in gitignore_content.splitlines()
        if line.strip() and not line.strip().startswith("#")
    )
    if not env_ignored:
        return
    env_example_path = os.path.join(project_dir, ".env.example")
    if os.path.isfile(env_example_path):
        return
    yield _make_env_finding(
        rule="R12",
        severity="MEDIUM",
        category="real-data",
        file=".gitignore",
        line=1,
        description=(
            ".env is gitignored but no .env.example file exists. "
            "Create .env.example with placeholder values so developers "
            "know which environment variables are required."
        ),
        scanner="env-check",
        confidence="high",
        confidence_reason="Deterministic: .env in .gitignore but .env.example missing",
    )


def _check_env_var_consistency(
    project_dir: str,
) -> Iterator[dict[str, str | int | list[str]]]:
    """Check for env vars referenced in code but missing from .env.example (LOW R12)."""
    env_example_path = os.path.join(project_dir, ".env.example")
    if not os.path.isfile(env_example_path):
        return
    example_keys = _parse_env_keys(env_example_path)
    code_vars = _scan_source_for_env_vars(project_dir)
    missing = code_vars - example_keys
    for var_name in sorted(missing):
        yield _make_env_finding(
            rule="R12",
            severity="LOW",
            category="real-data",
            file=".env.example",
            line=1,
            description=(
                f"Environment variable '{var_name}' is referenced in code "
                "but missing from .env.example."
            ),
            scanner="env-check",
            confidence="medium",
            confidence_reason=(
                f"Deterministic: '{var_name}' found in source but not in .env.example"
            ),
        )


def _check_duplicate_keys(
    project_dir: str,
) -> Iterator[dict[str, str | int | list[str]]]:
    """Check for duplicate keys in .env.example (LOW R09)."""
    env_example_path = os.path.join(project_dir, ".env.example")
    if not os.path.isfile(env_example_path):
        return
    seen: dict[str, int] = {}
    with open(env_example_path) as f:
        for line_num, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key = stripped.split("=", 1)[0].strip()
            if key in seen:
                yield _make_env_finding(
                    rule="R09",
                    severity="LOW",
                    category="clean-code",
                    file=".env.example",
                    line=line_num,
                    description=(
                        f"Duplicate key '{key}' in .env.example "
                        f"(first defined on line {seen[key]})."
                    ),
                    scanner="env-check",
                    confidence="high",
                    confidence_reason=(
                        f"Deterministic: key '{key}' appears on lines "
                        f"{seen[key]} and {line_num}"
                    ),
                )
            else:
                seen[key] = line_num


def _parse_env_keys(filepath: str) -> set[str]:
    """Parse an env file and return the set of variable names."""
    keys: set[str] = set()
    with open(filepath) as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key = stripped.split("=", 1)[0].strip()
            if key:
                keys.add(key)
    return keys


def _scan_source_for_env_vars(project_dir: str) -> set[str]:
    """Walk source files and extract referenced environment variable names."""
    env_vars: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(project_dir):
        # Skip common non-source directories
        dirnames[:] = [
            d for d in dirnames
            if d not in {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build",
                        ".next", ".turbo", "coverage", ".cache", ".nyc_output", "target", ".gradle"}
        ]
        for filename in filenames:
            _, ext = os.path.splitext(filename)
            if ext not in _SOURCE_EXTENSIONS:
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                with open(filepath) as f:
                    content = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            for pattern in _ENV_PATTERNS:
                env_vars.update(pattern.findall(content))
    return env_vars


def _make_env_finding(
    *,
    rule: str,
    severity: str,
    category: str,
    file: str,
    line: int,
    description: str,
    scanner: str,
    confidence: str,
    confidence_reason: str,
) -> dict[str, str | int | list[str]]:
    """Create a finding dict matching the dojutsu findings.jsonl schema."""
    phase_map: dict[str, int] = {
        "R05": 1, "R09": 5, "R12": 7,
    }
    return {
        "rule": rule,
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "end_line": line,
        "snippet": description[:200],
        "current_code": description[:200],
        "description": description,
        "explanation": description,
        "search_pattern": "",
        "phase": phase_map.get(rule, 5),
        "effort": "low",
        "scanner": scanner,
        "confidence": confidence,
        "confidence_reason": confidence_reason,
        "tool_rule_id": "",
        "cwe": [],
    }
