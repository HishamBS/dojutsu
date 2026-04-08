"""Run real linting tools and normalize output to findings.jsonl format.

Deterministic Gate 0 -- zero false positives on what these tools catch.
Tools are optional: if not installed, skip gracefully.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from typing import Iterator

# Tool -> rule mapping. Each tool finding maps to an R01-R20 rule.
ESLINT_RULE_MAP: dict[str, tuple[str, str, str]] = {
    "no-unused-vars": ("R14", "build", "MEDIUM"),
    "react-hooks/exhaustive-deps": ("R04", "performance", "HIGH"),
    "react-hooks/rules-of-hooks": ("R04", "performance", "CRITICAL"),
    "no-console": ("R09", "clean-code", "MEDIUM"),
    "@typescript-eslint/no-explicit-any": ("R07", "typing", "HIGH"),
    "@typescript-eslint/no-non-null-assertion": ("R07", "typing", "MEDIUM"),
    "jsx-a11y/*": ("R16", "full-stack", "MEDIUM"),
}
ESLINT_DEFAULT: tuple[str, str, str] = ("R14", "build", "MEDIUM")

RUFF_RULE_MAP: dict[str, tuple[str, str, str]] = {
    "F401": ("R14", "build", "LOW"),        # unused import
    "F841": ("R14", "build", "LOW"),        # unused variable
    "E501": ("R09", "clean-code", "LOW"),   # line too long
    "S101": ("R05", "security", "MEDIUM"),  # assert in production
    "S608": ("R05", "security", "HIGH"),    # SQL injection
    "S603": ("R05", "security", "HIGH"),    # subprocess shell=True
    "B006": ("R04", "performance", "MEDIUM"),  # mutable default
}
RUFF_DEFAULT: tuple[str, str, str] = ("R14", "build", "LOW")

MYPY_RULE_MAP: dict[str, tuple[str, str, str]] = {
    "assignment": ("R07", "typing", "MEDIUM"),
    "arg-type": ("R07", "typing", "MEDIUM"),
    "return-value": ("R07", "typing", "MEDIUM"),
    "name-defined": ("R14", "build", "HIGH"),
    "attr-defined": ("R07", "typing", "MEDIUM"),
    "override": ("R07", "typing", "LOW"),
}
MYPY_DEFAULT: tuple[str, str, str] = ("R07", "typing", "MEDIUM")

SEMGREP_SEVERITY_MAP: dict[str, str] = {
    "ERROR": "HIGH",
    "WARNING": "MEDIUM",
    "INFO": "LOW",
}


def detect_tools(stack: str, project_dir: str) -> list[str]:
    """Detect which linting tools are available for this stack."""
    available: list[str] = []
    checks: dict[str, list[tuple[str, list[str]]]] = {
        "typescript": [
            ("eslint", ["npx", "eslint", "--version"]),
            ("tsc", ["npx", "tsc", "--version"]),
            ("semgrep", ["semgrep", "--version"]),
        ],
        "python": [
            ("ruff", ["ruff", "--version"]),
            ("mypy", ["mypy", "--version"]),
            ("semgrep", ["semgrep", "--version"]),
        ],
        "java": [
            ("checkstyle", _checkstyle_version_cmd(project_dir)),
            ("semgrep", ["semgrep", "--version"]),
        ],
    }
    for tool_name, cmd in checks.get(stack, []):
        if not cmd:
            continue
        try:
            subprocess.run(cmd, capture_output=True, timeout=10)
            available.append(tool_name)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
    return available


def run_tool(tool: str, project_dir: str, stack: str) -> list[dict[str, str | int | list[str]]]:
    """Run a single tool and return normalized findings."""
    runners: dict[str, _RunnerFn] = {
        "eslint": _run_eslint,
        "tsc": _run_tsc,
        "ruff": _run_ruff,
        "mypy": _run_mypy,
        "semgrep": _run_semgrep,
        "checkstyle": _run_checkstyle,
    }
    runner = runners.get(tool)
    if not runner:
        return []
    try:
        return list(runner(project_dir, stack))
    except Exception:
        return []


# Type alias for runner callables
from typing import Callable
_RunnerFn = Callable[[str, str], Iterator[dict[str, str | int | list[str]]]]


def _run_eslint(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    result = subprocess.run(
        ["npx", "eslint", "--format", "json", "src/"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    for file_entry in json.loads(result.stdout):
        rel_path = os.path.relpath(file_entry["filePath"], project_dir)
        for msg in file_entry.get("messages", []):
            rule_id: str = msg.get("ruleId") or "parse-error"
            r_rule, category, severity = _map_eslint_rule(rule_id)
            yield _make_finding(
                rule=r_rule, severity=severity, category=category,
                file=rel_path, line=msg["line"],
                snippet=msg["message"][:200],
                description=msg["message"],
                scanner="eslint", confidence="high",
                confidence_reason=f"Deterministic: ESLint {rule_id}",
                tool_rule_id=rule_id,
            )


def _run_tsc(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    result = subprocess.run(
        ["npx", "tsc", "--noEmit", "--pretty", "false"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    pattern = re.compile(r"^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$")
    for line in result.stdout.splitlines():
        m = pattern.match(line)
        if m:
            message_text = m.group(6)
            is_type_related = "type" in message_text.lower()
            yield _make_finding(
                rule="R07" if is_type_related else "R14",
                severity="HIGH" if m.group(4) == "error" else "MEDIUM",
                category="typing" if is_type_related else "build",
                file=m.group(1), line=int(m.group(2)),
                snippet=message_text[:200],
                description=message_text,
                scanner="tsc", confidence="high",
                confidence_reason=f"Deterministic: TypeScript {m.group(5)}",
                tool_rule_id=m.group(5),
            )


def _run_ruff(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    result = subprocess.run(
        ["ruff", "check", "--output-format", "json", "."],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    for f in json.loads(result.stdout):
        code: str = f.get("code", "")
        r_rule, category, severity = RUFF_RULE_MAP.get(code, RUFF_DEFAULT)
        yield _make_finding(
            rule=r_rule, severity=severity, category=category,
            file=os.path.relpath(f["filename"], project_dir),
            line=f["location"]["row"],
            snippet=f["message"][:200],
            description=f["message"],
            scanner="ruff", confidence="high",
            confidence_reason=f"Deterministic: Ruff {code}",
            tool_rule_id=code,
        )


def _run_mypy(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    result = subprocess.run(
        [
            "mypy", "--output", "json",
            "--ignore-missing-imports",
            "--check-untyped-defs",
            "--no-error-summary",
            ".",
        ],
        capture_output=True, text=True, cwd=project_dir, timeout=180,
    )
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            f = json.loads(line)
        except json.JSONDecodeError:
            continue
        if f.get("severity") == "note":
            continue
        code: str = f.get("code", "")
        r_rule, category, severity = MYPY_RULE_MAP.get(code, MYPY_DEFAULT)
        yield _make_finding(
            rule=r_rule, severity=severity, category=category,
            file=f["file"], line=f["line"],
            snippet=f["message"][:200],
            description=f["message"],
            scanner="mypy", confidence="high",
            confidence_reason=f"Deterministic: mypy {code}",
            tool_rule_id=code,
        )


def _run_semgrep(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    configs: list[str] = ["auto"]
    if stack == "python":
        configs = ["p/python", "p/security-audit"]
    elif stack == "typescript":
        configs = ["p/typescript", "p/security-audit"]
    elif stack == "java":
        configs = ["p/java", "p/security-audit"]

    cmd: list[str] = ["semgrep", "--json", "--quiet"]
    for c in configs:
        cmd.extend(["--config", c])
    cmd.append(".")

    result = subprocess.run(
        cmd, capture_output=True, text=True, cwd=project_dir, timeout=300,
    )
    if not result.stdout.strip():
        return
    data = json.loads(result.stdout)
    for r in data.get("results", []):
        meta: dict[str, str | list[str]] = r.get("extra", {}).get("metadata", {})
        cwe_val = meta.get("cwe", [])
        cwe: list[str] = cwe_val if isinstance(cwe_val, list) else [str(cwe_val)]
        severity = SEMGREP_SEVERITY_MAP.get(
            r.get("extra", {}).get("severity", "INFO"), "LOW"
        )
        category_str: str = str(meta.get("category", ""))
        if "security" in category_str.lower():
            r_rule, category = "R05", "security"
        else:
            r_rule, category = "R14", "build"

        yield _make_finding(
            rule=r_rule, severity=severity, category=category,
            file=r["path"], line=r["start"]["line"],
            snippet=r.get("extra", {}).get("lines", "")[:200],
            description=r.get("extra", {}).get("message", ""),
            scanner="semgrep", confidence="high",
            confidence_reason=f"Deterministic: Semgrep {r['check_id']}",
            tool_rule_id=r["check_id"],
            cwe=cwe,
        )


def _run_checkstyle(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    jar = _find_checkstyle_jar(project_dir)
    if not jar:
        return
    src_dir = os.path.join(project_dir, "src")
    if not os.path.isdir(src_dir):
        return
    result = subprocess.run(
        ["java", "-jar", jar, "-c", "/google_checks.xml", "-f", "xml", src_dir],
        capture_output=True, text=True, cwd=project_dir, timeout=180,
    )
    if not result.stdout.strip():
        return
    try:
        root = ET.fromstring(result.stdout)
    except ET.ParseError:
        return
    for file_elem in root.findall("file"):
        filepath = os.path.relpath(file_elem.get("name", ""), project_dir)
        for error in file_elem.findall("error"):
            source: str = error.get("source", "")
            short_rule = source.split(".")[-1] if source else "unknown"
            sev: str = error.get("severity", "warning")
            is_javadoc = "javadoc" in source.lower()
            yield _make_finding(
                rule="R11" if is_javadoc else "R14",
                severity="HIGH" if sev == "error" else "LOW",
                category="documentation" if is_javadoc else "build",
                file=filepath,
                line=int(error.get("line", 0)),
                snippet=error.get("message", "")[:200],
                description=error.get("message", ""),
                scanner="checkstyle", confidence="high",
                confidence_reason=f"Deterministic: Checkstyle {short_rule}",
                tool_rule_id=short_rule,
            )


def _make_finding(
    *,
    rule: str,
    severity: str,
    category: str,
    file: str,
    line: int,
    snippet: str,
    description: str,
    scanner: str,
    confidence: str,
    confidence_reason: str,
    tool_rule_id: str = "",
    cwe: list[str] | None = None,
) -> dict[str, str | int | list[str]]:
    """Create a finding dict matching the dojutsu findings.jsonl schema."""
    return {
        "rule": rule,
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "end_line": line,
        "snippet": snippet,
        "current_code": snippet,
        "description": description,
        "explanation": description,
        "search_pattern": "",
        "phase": _phase_from_rule(rule),
        "effort": "low",
        "scanner": scanner,
        "confidence": confidence,
        "confidence_reason": confidence_reason,
        "tool_rule_id": tool_rule_id,
        "cwe": cwe or [],
    }


def _phase_from_rule(rule: str) -> int:
    """Map engineering rule to remediation phase number."""
    phase_map: dict[str, int] = {
        "R14": 0, "R05": 1, "R07": 2, "R01": 3, "R02": 4, "R03": 4,
        "R09": 5, "R13": 5, "R04": 6, "R12": 7, "R10": 8,
        "R16": 9, "R08": 9, "R11": 10,
    }
    return phase_map.get(rule, 5)


def _map_eslint_rule(rule_id: str) -> tuple[str, str, str]:
    """Map an ESLint rule ID to (engineering_rule, category, severity)."""
    if rule_id in ESLINT_RULE_MAP:
        return ESLINT_RULE_MAP[rule_id]
    for prefix, mapping in ESLINT_RULE_MAP.items():
        if prefix.endswith("/*") and rule_id.startswith(prefix[:-1]):
            return mapping
    return ESLINT_DEFAULT


def _checkstyle_version_cmd(project_dir: str) -> list[str]:
    """Build the version-check command for checkstyle, or return empty if jar not found."""
    jar = _find_checkstyle_jar(project_dir)
    if jar:
        return ["java", "-jar", jar, "--version"]
    return []


def _find_checkstyle_jar(project_dir: str) -> str | None:
    """Locate the checkstyle JAR file in standard locations."""
    for p in [
        os.path.expanduser("~/lib/checkstyle.jar"),
        "/usr/local/lib/checkstyle.jar",
        os.path.join(project_dir, "tools/checkstyle.jar"),
    ]:
        if os.path.isfile(p):
            return p
    return None
