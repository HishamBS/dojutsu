"""Run real linting tools and normalize output to findings.jsonl format.

Deterministic Gate 0 -- zero false positives on what these tools catch.
Tools are optional: if not installed, skip gracefully.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
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

# Per-tool timeout defaults in seconds
TOOL_TIMEOUT: dict[str, int] = {
    "semgrep": 300,
    "mypy": 180,
    "checkstyle": 180,
    "knip": 180,
}
DEFAULT_TOOL_TIMEOUT: int = 120

# Required fields every finding dict must contain
FINDING_REQUIRED_FIELDS: frozenset[str] = frozenset({
    "rule", "severity", "category", "file", "line", "description", "scanner",
})

# Retry configuration
RETRY_SLEEP_SECONDS: int = 3
MAX_RETRIES: int = 1


@dataclass
class ToolResult:
    """Structured result from running a single tool via run_tool_safe."""

    tool: str
    status: str  # "success" | "skipped" | "failed" | "timeout"
    findings: list[dict[str, str | int | list[str]]] = field(default_factory=list)
    duration_ms: int = 0
    error: str = ""
    finding_count: int = 0


def _validate_finding(finding: dict[str, str | int | list[str]]) -> bool:
    """Return True if a finding dict contains all required fields."""
    if not isinstance(finding, dict):
        return False
    return FINDING_REQUIRED_FIELDS.issubset(finding.keys())


def run_tool_safe(tool: str, project_dir: str, stack: str) -> ToolResult:
    """Run a single tool with retry, timeout handling, and output validation.

    Preferred over run_tool. Returns a ToolResult with structured status,
    timing, and validated findings.
    """
    start_ns = time.monotonic_ns()

    runners: dict[str, _RunnerFn] = _get_runners()
    runner = runners.get(tool)
    if not runner:
        elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
        return ToolResult(
            tool=tool, status="skipped", duration_ms=elapsed_ms,
            error=f"No runner registered for tool '{tool}'",
        )

    last_error = ""
    for attempt in range(MAX_RETRIES + 1):
        try:
            raw_findings = list(runner(project_dir, stack))
            # Validate each finding
            valid_findings: list[dict[str, str | int | list[str]]] = []
            for f in raw_findings:
                if _validate_finding(f):
                    valid_findings.append(f)
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            return ToolResult(
                tool=tool, status="success", findings=valid_findings,
                duration_ms=elapsed_ms, finding_count=len(valid_findings),
            )
        except subprocess.TimeoutExpired as exc:
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            return ToolResult(
                tool=tool, status="timeout", duration_ms=elapsed_ms,
                error=f"Tool timed out after {getattr(exc, 'timeout', 'unknown')}s",
            )
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_SLEEP_SECONDS)

    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
    return ToolResult(
        tool=tool, status="failed", duration_ms=elapsed_ms, error=last_error,
    )


def _get_runners() -> dict[str, _RunnerFn]:
    """Return the tool name -> runner function mapping."""
    return {
        "eslint": _run_eslint,
        "tsc": _run_tsc,
        "ruff": _run_ruff,
        "mypy": _run_mypy,
        "semgrep": _run_semgrep,
        "checkstyle": _run_checkstyle,
        "jscpd": _run_jscpd,
        "knip": _run_knip,
        "madge": _run_madge,
        "radon": _run_radon,
        "vulture": _run_vulture,
        "npm-audit": _run_npm_audit,
        "pip-audit": _run_pip_audit,
        "gitleaks": _run_gitleaks,
        "env-check": _run_env_check,
        "coverage": _run_coverage,
        "assertion-check": _run_assertion_check,
    }


def detect_tools(stack: str, project_dir: str) -> list[str]:
    """Detect which linting tools are available for this stack."""
    available: list[str] = []
    # Core linters (per-stack)
    checks: dict[str, list[tuple[str, list[str]]]] = {
        "typescript": [
            ("eslint", ["npx", "eslint", "--version"]),
            ("tsc", ["npx", "tsc", "--version"]),
            ("semgrep", ["semgrep", "--version"]),
            ("jscpd", ["npx", "jscpd", "--version"]),
            ("knip", ["npx", "knip", "--version"]),
            ("madge", ["npx", "madge", "--version"]),
            ("npm-audit", ["npm", "audit", "--version"]),
        ],
        "python": [
            ("ruff", ["ruff", "--version"]),
            ("mypy", ["mypy", "--version"]),
            ("semgrep", ["semgrep", "--version"]),
            ("jscpd", ["npx", "jscpd", "--version"]),
            ("radon", ["radon", "--version"]),
            ("vulture", ["vulture", "--version"]),
            ("pip-audit", ["pip-audit", "--version"]),
        ],
        "java": [
            ("checkstyle", _checkstyle_version_cmd(project_dir)),
            ("semgrep", ["semgrep", "--version"]),
            ("jscpd", ["npx", "jscpd", "--version"]),
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
    # Language-agnostic tools available for all stacks
    agnostic_tools: list[tuple[str, list[str]]] = [
        ("gitleaks", ["gitleaks", "version"]),
        ("env-check", []),  # no binary; always available
        ("coverage", []),  # no binary; reads existing reports
        ("assertion-check", []),  # no binary; AST/grep analysis
    ]
    for tool_name, cmd in agnostic_tools:
        if not cmd:
            available.append(tool_name)
            continue
        try:
            subprocess.run(cmd, capture_output=True, timeout=10)
            available.append(tool_name)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
    return available


def run_tool(tool: str, project_dir: str, stack: str) -> list[dict[str, str | int | list[str]]]:
    """Run a single tool and return normalized findings.

    Kept for backward compatibility. Prefer run_tool_safe for structured
    error handling, retry logic, and timing information.
    """
    runners = _get_runners()
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


def _run_jscpd(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect code duplication (R01 SSOT/DRY)."""
    import tempfile
    src = "src/" if os.path.isdir(os.path.join(project_dir, "src")) else "."
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(
            ["npx", "jscpd", src, "--reporters", "json", "--min-tokens", "50",
             "--min-lines", "5", "--output", tmpdir],
            capture_output=True, text=True, cwd=project_dir, timeout=120,
        )
        report_file = os.path.join(tmpdir, "jscpd-report.json")
        if not os.path.isfile(report_file):
            return
        with open(report_file) as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                return
    for dup in data.get("duplicates", []):
        first = dup.get("firstFile", {})
        second = dup.get("secondFile", {})
        lines = dup.get("lines", 0)
        yield _make_finding(
            rule="R01", severity="MEDIUM" if lines > 20 else "LOW",
            category="ssot-dry",
            file=first.get("name", ""),
            line=first.get("start", 0),
            snippet=f"{lines} duplicated lines also in {second.get('name', '')}:{second.get('start', 0)}",
            description=f"Code duplication: {lines} lines duplicated between {first.get('name', '')} and {second.get('name', '')}",
            scanner="jscpd", confidence="high",
            confidence_reason=f"Deterministic: jscpd token-based clone detection ({lines} lines)",
        )


def _run_knip(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect dead code: unused files, exports, dependencies (R09/R14)."""
    result = subprocess.run(
        ["npx", "knip", "--reporter", "json", "--no-progress"],
        capture_output=True, text=True, cwd=project_dir, timeout=180,
    )
    if not result.stdout.strip():
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    for unused_file in data.get("files", []):
        yield _make_finding(
            rule="R09", severity="MEDIUM", category="clean-code",
            file=unused_file, line=1,
            snippet="Entire file is unused (not imported anywhere)",
            description=f"Unused file: {unused_file} is not imported by any other file in the project",
            scanner="knip", confidence="high",
            confidence_reason="Deterministic: knip project-wide import analysis",
        )
    for export_info in data.get("exports", []):
        if isinstance(export_info, dict):
            f = export_info.get("file", "")
            name = export_info.get("name", "unknown")
            line_num = export_info.get("line", 1)
        else:
            continue
        yield _make_finding(
            rule="R09", severity="LOW", category="clean-code",
            file=f, line=line_num,
            snippet=f"Unused export: {name}",
            description=f"Exported symbol '{name}' is not imported anywhere in the project",
            scanner="knip", confidence="high",
            confidence_reason="Deterministic: knip export analysis",
        )
    for dep in data.get("dependencies", []):
        dep_name = dep if isinstance(dep, str) else dep.get("name", "")
        yield _make_finding(
            rule="R14", severity="LOW", category="build",
            file="package.json", line=1,
            snippet=f"Unused dependency: {dep_name}",
            description=f"Dependency '{dep_name}' is listed in package.json but not imported",
            scanner="knip", confidence="high",
            confidence_reason="Deterministic: knip dependency analysis",
        )


def _run_madge(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect circular dependencies (R10 refactoring)."""
    src = "src/" if os.path.isdir(os.path.join(project_dir, "src")) else "."
    result = subprocess.run(
        ["npx", "madge", "--circular", "--json", src],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    try:
        cycles = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    for cycle in cycles:
        if not isinstance(cycle, list) or len(cycle) < 2:
            continue
        first_file = cycle[0]
        chain = " -> ".join(cycle)
        yield _make_finding(
            rule="R10", severity="MEDIUM", category="refactoring",
            file=first_file, line=1,
            snippet=f"Circular: {chain}",
            description=f"Circular dependency chain: {chain}",
            scanner="madge", confidence="high",
            confidence_reason="Deterministic: madge import graph analysis",
        )


def _run_radon(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect high-complexity functions (R02 separation of concerns / R09 clean code)."""
    result = subprocess.run(
        ["radon", "cc", ".", "-s", "-j", "--min", "C"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    for filepath, functions in data.items():
        rel_path = os.path.relpath(filepath, project_dir) if os.path.isabs(filepath) else filepath
        for func in functions:
            complexity = func.get("complexity", 0)
            name = func.get("name", "unknown")
            lineno = func.get("lineno", 1)
            rank = func.get("rank", "C")
            if complexity < 10:
                continue
            severity = "HIGH" if complexity >= 20 else "MEDIUM"
            yield _make_finding(
                rule="R02", severity=severity, category="architecture",
                file=rel_path, line=lineno,
                snippet=f"{name}: complexity {complexity} (rank {rank})",
                description=f"Function '{name}' has cyclomatic complexity {complexity} (rank {rank}). Consider splitting into smaller functions.",
                scanner="radon", confidence="high",
                confidence_reason=f"Deterministic: radon cyclomatic complexity {complexity} (threshold 10)",
            )


def _run_vulture(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect dead Python code: unused functions, variables, imports (R09)."""
    result = subprocess.run(
        ["vulture", ".", "--min-confidence", "80"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    pattern = re.compile(r"^(.+?):(\d+): unused (\w+) '(.+?)' \((\d+)% confidence\)$")
    for line in result.stdout.splitlines():
        m = pattern.match(line)
        if not m:
            continue
        filepath, linenum, kind, name, conf = m.groups()
        rel_path = os.path.relpath(filepath, project_dir) if os.path.isabs(filepath) else filepath
        yield _make_finding(
            rule="R09", severity="LOW", category="clean-code",
            file=rel_path, line=int(linenum),
            snippet=f"unused {kind} '{name}' ({conf}% confidence)",
            description=f"Unused {kind}: '{name}' appears to be dead code ({conf}% confidence)",
            scanner="vulture", confidence="medium" if int(conf) < 90 else "high",
            confidence_reason=f"Deterministic: vulture dead code detection ({conf}% confidence)",
        )


def _run_npm_audit(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect dependency vulnerabilities in npm packages (R05 security)."""
    if not os.path.isfile(os.path.join(project_dir, "package-lock.json")):
        return
    result = subprocess.run(
        ["npm", "audit", "--json"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    vulns = data.get("vulnerabilities", {})
    for pkg_name, info in vulns.items():
        severity_raw = (info.get("severity") or "low").upper()
        if severity_raw not in ("CRITICAL", "HIGH", "MODERATE", "LOW"):
            severity_raw = "MEDIUM"
        severity_raw = severity_raw.replace("MODERATE", "MEDIUM")
        via = info.get("via", [])
        desc_parts: list[str] = []
        for v in via:
            if isinstance(v, dict):
                desc_parts.append(v.get("title", v.get("name", "")))
            elif isinstance(v, str):
                desc_parts.append(v)
        desc = "; ".join(desc_parts[:3]) or f"Vulnerability in {pkg_name}"
        yield _make_finding(
            rule="R05", severity=severity_raw, category="security",
            file="package.json", line=1,
            snippet=f"{pkg_name}: {desc}",
            description=f"Dependency vulnerability: {pkg_name} — {desc}",
            scanner="npm-audit", confidence="high",
            confidence_reason=f"Deterministic: npm audit CVE database ({severity_raw})",
        )


def _run_gitleaks(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect hardcoded secrets in source code (R05 security)."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        subprocess.run(
            [
                "gitleaks", "detect",
                "--source", ".",
                "--no-git",
                "--report-format", "json",
                "--report-path", tmp_path,
            ],
            capture_output=True, text=True, cwd=project_dir, timeout=120,
        )
        if not os.path.isfile(tmp_path) or os.path.getsize(tmp_path) == 0:
            return
        with open(tmp_path) as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                return
    finally:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
    if not isinstance(data, list):
        return
    for entry in data:
        rel_file: str = entry.get("File", "")
        start_line: int = entry.get("StartLine", 1)
        end_line: int = entry.get("EndLine", start_line)
        description: str = entry.get("Description", "Secret detected")
        rule_id: str = entry.get("RuleID", "unknown")
        yield _make_finding(
            rule="R05", severity="CRITICAL", category="security",
            file=rel_file, line=start_line,
            snippet=f"[REDACTED] {description}",
            description=f"Hardcoded secret detected: {description} (rule: {rule_id})",
            scanner="gitleaks", confidence="high",
            confidence_reason=f"Deterministic: gitleaks {rule_id}",
            tool_rule_id=rule_id,
        )


def _run_env_check(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Run env consistency checks (R05 security, R12 real data, R09 clean code)."""
    from env_checker import check_env
    for finding in check_env(project_dir, stack):
        yield finding


def _run_coverage(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Analyze existing test coverage reports for uncovered functions (R08)."""
    from coverage_analyzer import analyze_coverage
    for finding in analyze_coverage(project_dir, stack):
        yield finding


def _run_assertion_check(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect test functions with zero assertions (R08)."""
    from assertion_detector import detect_assertion_free_tests
    for finding in detect_assertion_free_tests(project_dir, stack):
        yield finding


def _run_pip_audit(project_dir: str, stack: str) -> Iterator[dict[str, str | int | list[str]]]:
    """Detect dependency vulnerabilities in Python packages (R05 security)."""
    result = subprocess.run(
        ["pip-audit", "--format", "json"],
        capture_output=True, text=True, cwd=project_dir, timeout=120,
    )
    if not result.stdout.strip():
        return
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    deps = data if isinstance(data, list) else data.get("dependencies", [])
    for dep in deps:
        vulns = dep.get("vulns", [])
        if not vulns:
            continue
        pkg = dep.get("name", "unknown")
        ver = dep.get("version", "")
        for vuln in vulns:
            vuln_id = vuln.get("id", "")
            desc = vuln.get("description", f"Vulnerability in {pkg}")[:200]
            fix_vers = vuln.get("fix_versions", [])
            # Use official severity from pip-audit if available, else infer
            raw_sev = (vuln.get("severity") or "").upper()
            if raw_sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
                severity = raw_sev
            else:
                severity = "HIGH" if "critical" in desc.lower() else "MEDIUM"
            yield _make_finding(
                rule="R05", severity=severity, category="security",
                file="requirements.txt", line=1,
                snippet=f"{pkg}=={ver}: {vuln_id}",
                description=f"Dependency vulnerability: {pkg}=={ver} — {vuln_id}: {desc}",
                scanner="pip-audit", confidence="high",
                confidence_reason=f"Deterministic: pip-audit OSV database ({vuln_id})",
            )


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
