#!/usr/bin/env python3
"""Deterministically generate phase task files from published findings."""
from __future__ import annotations

import json
import os
import sys
from typing import Any

from run_pipeline_lib import SPEC_PHASE_EDGES, SPEC_PHASE_NODES


BUILD_COMMANDS: dict[str, str] = {
    "typescript": "npx tsc --noEmit >/dev/null 2>&1 && echo PASS",
    "python": "python3 -m compileall -q . >/dev/null 2>&1 && echo PASS",
    "java": "mvn -q -DskipTests compile >/dev/null 2>&1 && echo PASS",
}

TYPE_COMMANDS: dict[str, str] = {
    "typescript": "grep -RInE '\\bany\\b' . --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' | wc -l | tr -d ' '",
    "python": "grep -RInE '\\bAny\\b|type:\\s*ignore|typing\\.Any' . --include='*.py' | wc -l | tr -d ' '",
    "java": "grep -RInE '@SuppressWarnings\\(\"unchecked\"\\)|\\(.*\\)' . --include='*.java' --include='*.kt' | wc -l | tr -d ' '",
}


def _load_json(path: str) -> dict[str, Any]:
    with open(path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path) as fh:
        for raw_line in fh:
            stripped = raw_line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def _phase_prerequisites() -> dict[int, list[str]]:
    prereqs: dict[int, list[str]] = {node["id"]: [] for node in SPEC_PHASE_NODES}
    for edge in SPEC_PHASE_EDGES:
        prereqs[edge["to"]].append(f"phase-{edge['from']}")
    return prereqs


def _phase_rule_map() -> dict[str, int]:
    mapping: dict[str, int] = {}
    for node in SPEC_PHASE_NODES:
        for rule in node["rules"]:
            mapping[rule] = node["id"]
    return mapping


def _normalize_imports(target_import: Any) -> list[str]:
    if isinstance(target_import, list):
        return [str(item) for item in target_import if str(item).strip()]
    if isinstance(target_import, str) and target_import.strip():
        return [target_import.strip()]
    return []


def _determine_phase(finding: dict[str, Any], phase_by_rule: dict[str, int]) -> int:
    phase = finding.get("phase")
    if isinstance(phase, int) and 0 <= phase <= 10:
        return phase
    rule = str(finding.get("rule", "")).strip()
    return phase_by_rule.get(rule, 10)


def _stack_has_tests(project_dir: str, stack: str) -> bool:
    if stack == "typescript":
        package_json = os.path.join(project_dir, "package.json")
        if not os.path.isfile(package_json):
            return False
        try:
            package = _load_json(package_json)
        except json.JSONDecodeError:
            return False
        scripts = package.get("scripts", {})
        return isinstance(scripts, dict) and bool(str(scripts.get("test", "")).strip())
    if stack == "python":
        for candidate in ("tests", "test", "pytest.ini", "pyproject.toml"):
            if os.path.exists(os.path.join(project_dir, candidate)):
                return True
        return False
    if stack == "java":
        return os.path.exists(os.path.join(project_dir, "pom.xml")) or os.path.exists(
            os.path.join(project_dir, "build.gradle")
        )
    return False


def _verification_for_phase(phase_id: int, stack: str, project_dir: str) -> dict[str, str]:
    if phase_id == 0:
        command = BUILD_COMMANDS.get(stack, "echo MANUAL_REVIEW_REQUIRED")
        expected = "PASS" if command != "echo MANUAL_REVIEW_REQUIRED" else "MANUAL_REVIEW_REQUIRED"
        return {
            "command": command,
            "expected": expected,
            "description": "Project builds cleanly before remediation begins.",
        }

    if phase_id == 1:
        return {
            "command": "grep -RInE 'verify=False|shell=True|exec\\(|eval\\(|subprocess\\..*shell=True' . | wc -l | tr -d ' '",
            "expected": "0",
            "description": "No obvious high-risk security shortcuts remain.",
        }

    if phase_id == 2:
        command = TYPE_COMMANDS.get(stack, "echo MANUAL_REVIEW_REQUIRED")
        expected = "0" if command != "echo MANUAL_REVIEW_REQUIRED" else "MANUAL_REVIEW_REQUIRED"
        return {
            "command": command,
            "expected": expected,
            "description": "Phase-specific typing shortcuts are removed.",
        }

    if phase_id == 5:
        return {
            "command": "grep -RInE 'console\\.log|TODO|FIXME' . --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.java' --include='*.kt' | wc -l | tr -d ' '",
            "expected": "0",
            "description": "No obvious hygiene placeholders remain in source files.",
        }

    if phase_id == 9:
        build_command = BUILD_COMMANDS.get(stack)
        if build_command and _stack_has_tests(project_dir, stack):
            if stack == "typescript":
                command = "npm test -- --runInBand >/dev/null 2>&1 && npx tsc --noEmit >/dev/null 2>&1 && echo PASS"
            elif stack == "python":
                command = "pytest -q >/dev/null 2>&1 && python3 -m compileall -q . >/dev/null 2>&1 && echo PASS"
            else:
                command = "mvn -q test >/dev/null 2>&1 && echo PASS"
            return {
                "command": command,
                "expected": "PASS",
                "description": "Build and test verification pass for this stack.",
            }
        if build_command:
            return {
                "command": build_command,
                "expected": "PASS",
                "description": "Build verification passes; no stack-level test command was detected.",
            }

    return {
        "command": "echo MANUAL_REVIEW_REQUIRED",
        "expected": "MANUAL_REVIEW_REQUIRED",
        "description": "Manual verification required for this architectural phase.",
    }


def _transform_task(finding: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": finding.get("id", ""),
        "status": "pending",
        "rule": finding.get("rule", ""),
        "severity": finding.get("severity", ""),
        "group": finding.get("group", ""),
        "file": finding.get("file", ""),
        "line": finding.get("line", 0),
        "current_code": finding.get("current_code"),
        "target_code": finding.get("target_code"),
        "imports_needed": _normalize_imports(finding.get("target_import")),
        "search_pattern": finding.get("search_pattern", ""),
        "explanation": finding.get("explanation", ""),
        "effort": finding.get("effort", ""),
        "fix_plan": finding.get("fix_plan"),
        "completed_at": None,
        "resolution": None,
        "actual_line": None,
        "notes": "",
    }


def generate_phase_tasks(audit_dir: str, project_dir: str) -> list[str]:
    findings = _load_jsonl(os.path.join(audit_dir, "data", "findings.jsonl"))
    inventory = _load_json(os.path.join(audit_dir, "data", "inventory.json"))
    stack = str(inventory.get("stack", "unknown"))
    phase_by_rule = _phase_rule_map()
    prerequisites = _phase_prerequisites()

    findings_by_phase: dict[int, list[dict[str, Any]]] = {node["id"]: [] for node in SPEC_PHASE_NODES}
    ordered_findings = sorted(
        findings,
        key=lambda finding: (
            _determine_phase(finding, phase_by_rule),
            str(finding.get("file", "")),
            int(finding.get("line", 0) or 0),
            str(finding.get("id", "")),
        ),
    )
    for finding in ordered_findings:
        phase_id = _determine_phase(finding, phase_by_rule)
        findings_by_phase[phase_id].append(_transform_task(finding))

    written: list[str] = []
    tasks_dir = os.path.join(audit_dir, "data", "tasks")
    os.makedirs(tasks_dir, exist_ok=True)
    for node in SPEC_PHASE_NODES:
        phase_id = node["id"]
        tasks = findings_by_phase[phase_id]
        payload = {
            "phase": phase_id,
            "phase_name": f"{node['name']} ({', '.join(node['rules'])})",
            "prerequisites": prerequisites[phase_id],
            "status": "clear" if not tasks else "not_started",
            "total_tasks": len(tasks),
            "completed": 0,
            "tasks": tasks,
            "verification": _verification_for_phase(phase_id, stack, project_dir),
        }
        path = os.path.join(tasks_dir, f"phase-{phase_id}-tasks.json")
        with open(path, "w") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        written.append(path)
    return written


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: create-phase-tasks.py <audit_dir> [project_dir]")
        return 1
    audit_dir = os.path.abspath(argv[1])
    project_dir = os.path.abspath(argv[2]) if len(argv) > 2 else os.path.dirname(os.path.dirname(audit_dir))
    written = generate_phase_tasks(audit_dir, project_dir)
    print(f"Generated {len(written)} phase task files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
