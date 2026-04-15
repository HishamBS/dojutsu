"""Deterministic audit publication contract helpers.

Defines canonical output paths, generates phase markdown docs from task JSON,
publishes a report manifest, and validates the published audit bundle.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter
from typing import Any

from bundle_renderer import render_bundle, write_bundle_verdict
from run_pipeline_lib import PHASE_FILE_SLUGS, SPEC_PHASE_EDGES, SPEC_PHASE_NODES, validate_null_fix_coverage


def canonical_layer_doc_relpath(layer: str) -> str:
    return f"layers/{layer}.md"


def canonical_phase_doc_relpath(phase_id: int) -> str:
    slug = PHASE_FILE_SLUGS[phase_id]
    return f"phases/phase-{phase_id}-{slug}.md"


def _load_json(path: str) -> dict[str, Any] | None:
    if not os.path.isfile(path):
        return None
    with open(path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    if not os.path.isfile(path):
        return []
    items: list[dict[str, Any]] = []
    with open(path) as fh:
        for raw_line in fh:
            raw_line = raw_line.strip()
            if raw_line:
                items.append(json.loads(raw_line))
    return items


def _phase_index() -> dict[int, dict[str, Any]]:
    return {node["id"]: node for node in SPEC_PHASE_NODES}


def _phase_prerequisites() -> dict[int, list[str]]:
    prereqs: dict[int, list[str]] = {node["id"]: [] for node in SPEC_PHASE_NODES}
    for edge in SPEC_PHASE_EDGES:
        prereqs[edge["to"]].append(f"phase-{edge['from']}")
    return prereqs


def _phase_counts_from_findings(findings: list[dict[str, Any]]) -> Counter[int]:
    counts: Counter[int] = Counter()
    for finding in findings:
        phase = finding.get("phase")
        if isinstance(phase, int):
            counts[phase] += 1
    return counts


def _phase_task_path(audit_dir: str, phase_id: int) -> str:
    return os.path.join(audit_dir, "data", "tasks", f"phase-{phase_id}-tasks.json")


def _task_summary(task: dict[str, Any]) -> str:
    target_code = task.get("target_code")
    if isinstance(target_code, str) and target_code.strip():
        preview = target_code.strip().splitlines()[0].strip()
        return f"Replace with `{preview[:100]}`."

    fix_plan = task.get("fix_plan")
    if isinstance(fix_plan, list) and fix_plan:
        actions = [str(step.get("action", "edit")) for step in fix_plan]
        return f"Plan: {', '.join(actions[:4])}."

    return "No deterministic replacement captured."


def generate_phase_docs(audit_dir: str) -> list[str]:
    """Generate deterministic markdown docs for all remediation phases."""
    findings = _load_jsonl(os.path.join(audit_dir, "data", "findings.jsonl"))
    phase_counts = _phase_counts_from_findings(findings)
    phase_nodes = _phase_index()
    prerequisites = _phase_prerequisites()
    out_dir = os.path.join(audit_dir, "phases")
    os.makedirs(out_dir, exist_ok=True)

    written: list[str] = []
    for phase_id in sorted(phase_nodes):
        node = phase_nodes[phase_id]
        task_path = _phase_task_path(audit_dir, phase_id)
        task_data = _load_json(task_path) if os.path.isfile(task_path) else None
        tasks = task_data.get("tasks", []) if task_data else []
        verification = task_data.get("verification", {}) if task_data else {}
        total_tasks = len(tasks) if task_data else phase_counts.get(phase_id, 0)
        completed = task_data.get("completed", 0) if task_data else 0
        status = task_data.get("status") if task_data else None
        if not status:
            status = "clear" if total_tasks == 0 else "not_started"
        phase_name = task_data.get("phase_name") if task_data else None
        heading_name = phase_name or f"{node['name']} ({', '.join(node['rules'])})"
        prereq_list = task_data.get("prerequisites") if task_data else None
        if prereq_list is None:
            prereq_list = prerequisites[phase_id]
        prereq_text = ", ".join(prereq_list) if prereq_list else "None"

        lines = [
            f"# Phase {phase_id}: {heading_name}",
            "",
            f"> **Rules:** {', '.join(node['rules'])} | **Prerequisites:** {prereq_text}",
            f"> **Tasks:** {total_tasks} | **Completed:** {completed} | **Status:** {status}",
            "",
            "## Summary",
            "",
            f"This phase covers `{node['name']}` findings and is generated deterministically from task data.",
            "",
            "## Verification",
            "",
        ]

        if verification:
            lines.extend([
                f"- Command: `{verification.get('command', 'echo MANUAL_REVIEW_REQUIRED')}`",
                f"- Expected: `{verification.get('expected', '')}`",
                f"- Description: {verification.get('description', 'No verification description provided.')}",
            ])
        else:
            lines.append("- Command: `echo MANUAL_REVIEW_REQUIRED`")

        lines.extend(["", "## Tasks", ""])
        if tasks:
            lines.extend([
                "| ID | Severity | File | Line | Status |",
                "|----|----------|------|------|--------|",
            ])
            for task in tasks:
                lines.append(
                    f"| {task.get('id', '')} | {task.get('severity', '')} | "
                    f"`{task.get('file', '')}` | {task.get('line', '')} | {task.get('status', '')} |"
                )
            lines.extend(["", "## Task Details", ""])
            for task in tasks:
                lines.extend([
                    f"### {task.get('id', '')}",
                    "",
                    f"- File: `{task.get('file', '')}:{task.get('line', '')}`",
                    f"- Search pattern: `{task.get('search_pattern', '')}`",
                    f"- Effort: `{task.get('effort', '')}`",
                    f"- Explanation: {task.get('explanation', '')}",
                    f"- Fix: {_task_summary(task)}",
                    "",
                ])
        else:
            lines.extend([
                "No findings are assigned to this phase.",
                "",
                "## Task Details",
                "",
                "This phase is currently clear.",
                "",
            ])

        relpath = canonical_phase_doc_relpath(phase_id)
        full_path = os.path.join(audit_dir, relpath)
        with open(full_path, "w") as fh:
            fh.write("\n".join(lines).rstrip() + "\n")
        written.append(relpath)

    return written


def generate_report_manifest(audit_dir: str) -> dict[str, Any]:
    """Write the deterministic report manifest used by validators and generators."""
    stats = _load_json(os.path.join(audit_dir, "data", "audit-stats.json")) or {}
    inventory = _load_json(os.path.join(audit_dir, "data", "inventory.json")) or {}
    layer_names = [layer["name"] for layer in stats.get("layers", [])]
    if not layer_names:
        layer_names = sorted((inventory.get("layers") or {}).keys())

    manifest = {
        "version": 1,
        "authoritative_sources": {
            "findings": "data/findings.jsonl",
            "metrics": "data/audit-stats.json",
            "phase_dag": "data/phase-dag.json",
            "phase_tasks": "data/tasks/phase-*-tasks.json",
            "clusters": "deep/clusters.json",
        },
        "canonical_paths": {
            "master_audit": "master-audit.md",
            "cross_cutting": "cross-cutting.md",
            "progress": "progress.md",
            "agent_instructions": "agent-instructions.md",
            "layer_docs": [canonical_layer_doc_relpath(name) for name in layer_names],
            "phase_docs": [canonical_phase_doc_relpath(node["id"]) for node in SPEC_PHASE_NODES],
        },
        "required_outputs": {
            "rinnegan": [
                "master-audit.md",
                "cross-cutting.md",
                "progress.md",
                "agent-instructions.md",
                "data/findings.jsonl",
                "data/inventory.json",
                "data/phase-dag.json",
                "data/audit-stats.json",
                "data/report-manifest.json",
                *[canonical_layer_doc_relpath(name) for name in layer_names],
                *[canonical_phase_doc_relpath(node["id"]) for node in SPEC_PHASE_NODES],
            ],
            "byakugan": [
                "deep/dependency-graph.json",
                "deep/clusters.json",
                "deep/impact-analysis.jsonl",
                "deep/narrative.md",
                "deep/scorecard.md",
                "deep/deployment-plan.md",
                "deep/executive-brief.md",
            ],
        },
    }

    path = os.path.join(audit_dir, "data", "report-manifest.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    return manifest


def _extract_relative_links(markdown: str) -> list[str]:
    links = re.findall(r"\[[^\]]+\]\(([^)]+)\)", markdown)
    return [link.split("#", 1)[0] for link in links if link and not re.match(r"^[a-z]+://", link)]


def _parse_int(value: str) -> int:
    return int(value.replace(",", "").strip())


def _validate_master_audit(master_path: str, stats: dict[str, Any], layer_names: list[str]) -> list[str]:
    errors: list[str] = []
    if not os.path.isfile(master_path):
        return ["master-audit.md missing"]

    with open(master_path) as fh:
        content = fh.read()

    meta_match = re.search(
        r"\*\*Files:\*\*\s*([\d,]+)\s*\|\s*\*\*LOC:\*\*\s*([\d,]+)\s*\|\s*\*\*Findings:\*\*\s*([\d,]+)",
        content,
    )
    if not meta_match:
        errors.append("master-audit.md missing Files/LOC/Findings header")
    else:
        files_count, loc_count, finding_count = (_parse_int(meta_match.group(i)) for i in range(1, 4))
        if files_count != stats.get("total_files", 0):
            errors.append(f"master-audit.md files={files_count} != audit-stats total_files={stats.get('total_files', 0)}")
        if loc_count != stats.get("total_loc", 0):
            errors.append(f"master-audit.md loc={loc_count} != audit-stats total_loc={stats.get('total_loc', 0)}")
        if finding_count != stats.get("total_findings", 0):
            errors.append(
                f"master-audit.md findings={finding_count} != audit-stats total_findings={stats.get('total_findings', 0)}"
            )

    severity_rows = {
        level: count for level, count in re.findall(
            r"^\|\s*(CRITICAL|HIGH|MEDIUM|LOW|REVIEW)\s*\|\s*([\d,]+)\s*\|",
            content,
            flags=re.MULTILINE,
        )
    }
    expected_severity = stats.get("severity", {})
    for level in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"):
        rendered = _parse_int(severity_rows.get(level, "0"))
        expected = int(expected_severity.get(level, 0))
        if rendered != expected:
            errors.append(f"master-audit.md severity {level}={rendered} != audit-stats {expected}")

    rendered_layers = set(re.findall(r"layers/([A-Za-z0-9_-]+\.md)", content))
    for layer_name in layer_names:
        expected_rel = os.path.basename(canonical_layer_doc_relpath(layer_name))
        if expected_rel not in rendered_layers:
            errors.append(f"master-audit.md missing canonical layer link for {layer_name}")

    phase_rows = {
        int(phase): _parse_int(count)
        for phase, count, _link in re.findall(
            r"^\|\s*(\d+)\s*\|[^|\n]+\|\s*([\d,]+)\s*\|[^|\n]*\|\s*\[phase-\d+\]\((phases/[^)]+)\)\s*\|?$",
            content,
            flags=re.MULTILINE,
        )
    }
    stats_phase_counts = {int(entry["phase"]): int(entry["findings"]) for entry in stats.get("phases", [])}
    for phase_id in range(len(SPEC_PHASE_NODES)):
        rendered = phase_rows.get(phase_id)
        if rendered is None:
            errors.append(f"master-audit.md missing phase row for phase {phase_id}")
            continue
        expected = stats_phase_counts.get(phase_id, 0)
        if rendered != expected:
            errors.append(f"master-audit.md phase {phase_id} count={rendered} != audit-stats {expected}")

    return errors


def validate_publication_contract(audit_dir: str, stage: str = "rinnegan") -> dict[str, Any]:
    """Validate the published audit bundle against the canonical contract."""
    manifest = _load_json(os.path.join(audit_dir, "data", "report-manifest.json"))
    if manifest is None:
        manifest = generate_report_manifest(audit_dir)

    required_outputs = manifest["required_outputs"].get(stage, [])
    errors: list[str] = []
    for relpath in required_outputs:
        if not os.path.exists(os.path.join(audit_dir, relpath)):
            errors.append(f"missing required output: {relpath}")

    findings = _load_jsonl(os.path.join(audit_dir, "data", "findings.jsonl"))
    stats = _load_json(os.path.join(audit_dir, "data", "audit-stats.json")) or {}
    quality_gate = _load_json(os.path.join(audit_dir, "data", "quality-gate.json")) or {}
    families = _load_json(os.path.join(audit_dir, "data", "finding-families.json")) or {}
    null_fix_validation = validate_null_fix_coverage(audit_dir)
    if null_fix_validation["triggered"]:
        errors.append(
            "null-fix contract violated: "
            f"{null_fix_validation['null_fix_count']}/{null_fix_validation['non_review_count']} "
            f"non-REVIEW findings are missing both target_code and fix_plan"
        )

    phase_counts = _phase_counts_from_findings(findings)
    if not stats:
        errors.append("audit-stats.json missing or unreadable")
    else:
        if stats.get("total_findings", 0) != len(findings):
            errors.append(
                f"audit-stats total_findings={stats.get('total_findings', 0)} != findings.jsonl lines={len(findings)}"
            )

        severity_counts = Counter(str(f.get("severity", "MEDIUM")) for f in findings)
        for level, expected in (stats.get("severity") or {}).items():
            if severity_counts.get(level, 0) != int(expected):
                errors.append(
                    f"audit-stats severity {level}={expected} != findings-derived {severity_counts.get(level, 0)}"
                )

        stats_phase_counts = {int(entry["phase"]): int(entry["findings"]) for entry in stats.get("phases", [])}
        for phase_id in range(len(SPEC_PHASE_NODES)):
            derived = phase_counts.get(phase_id, 0)
            expected = stats_phase_counts.get(phase_id, 0)
            if derived != expected:
                errors.append(f"audit-stats phase {phase_id}={expected} != findings-derived {derived}")
        affected_files = len({str(finding.get("file", "")) for finding in findings if str(finding.get("file", ""))})
        if int(stats.get("affected_files", 0)) != affected_files:
            errors.append(f"audit-stats affected_files={stats.get('affected_files', 0)} != findings-derived {affected_files}")

    layer_names = [layer["name"] for layer in stats.get("layers", [])]
    if stage == "rinnegan":
        master_errors = _validate_master_audit(os.path.join(audit_dir, "master-audit.md"), stats, layer_names)
        errors.extend(master_errors)

    for md_name in ("master-audit.md", "cross-cutting.md"):
        md_path = os.path.join(audit_dir, md_name)
        if not os.path.isfile(md_path):
            continue
        with open(md_path) as fh:
            markdown = fh.read()
        for rel_link in _extract_relative_links(markdown):
            if not rel_link:
                continue
            if not os.path.exists(os.path.join(audit_dir, rel_link)):
                errors.append(f"{md_name} has broken link: {rel_link}")

    for phase_id in range(len(SPEC_PHASE_NODES)):
        task_path = _phase_task_path(audit_dir, phase_id)
        if not os.path.isfile(task_path):
            if phase_counts.get(phase_id, 0) > 0:
                errors.append(f"missing phase task file for phase {phase_id}")
            continue
        task_data = _load_json(task_path) or {}
        tasks = task_data.get("tasks", [])
        declared_total = int(task_data.get("total_tasks", len(tasks)))
        if declared_total != len(tasks):
            errors.append(f"{os.path.relpath(task_path, audit_dir)} total_tasks={declared_total} != actual tasks={len(tasks)}")
        derived_count = _phase_counts_from_findings(findings).get(phase_id, 0)
        if derived_count != len(tasks):
            errors.append(f"{os.path.relpath(task_path, audit_dir)} tasks={len(tasks)} != findings-derived phase count={derived_count}")

    if stage == "byakugan":
        clusters = _load_json(os.path.join(audit_dir, "deep", "clusters.json")) or {}
        cluster_ids = {cluster.get("id", "") for cluster in clusters.get("clusters", [])}
        if not cluster_ids:
            errors.append("clusters.json missing clusters")
        for finding in findings:
            cluster_id = finding.get("cluster_id")
            if not cluster_id:
                errors.append(f"finding {finding.get('id', '')} missing cluster_id")
                continue
            if cluster_id not in cluster_ids:
                errors.append(f"finding {finding.get('id', '')} references unknown cluster_id {cluster_id}")

    root_ids = {
        str(finding.get("id", ""))
        for finding in findings
        if finding.get("is_root_cause") is True
    }
    valid_ids = {str(finding.get("id", "")) for finding in findings}
    for finding in findings:
        parent_id = finding.get("parent_finding_id")
        if not parent_id:
            continue
        if str(parent_id) not in valid_ids:
            errors.append(f"finding {finding.get('id', '')} references missing parent_finding_id {parent_id}")
        if str(parent_id) not in root_ids:
            errors.append(f"finding {finding.get('id', '')} parent_finding_id {parent_id} is not marked root cause")

    family_entries = families.get("families", []) if isinstance(families.get("families"), list) else []
    for family in family_entries:
        root_id = str(family.get("root_finding_id", ""))
        if root_id and root_id not in valid_ids:
            errors.append(f"family {family.get('id', '')} references missing root finding {root_id}")

    if quality_gate:
        blockers = quality_gate.get("blocker_explanation", {})
        for tier_name, finding_ids in blockers.items():
            if not isinstance(finding_ids, list):
                errors.append(f"quality-gate blocker_explanation for {tier_name} is not a list")
                continue
            for finding_id in finding_ids:
                if str(finding_id) not in valid_ids:
                    errors.append(f"quality-gate {tier_name} blocker references missing finding id {finding_id}")
        for tier_name, payload in (quality_gate.get("tiers") or {}).items():
            if not isinstance(payload, dict):
                continue
            if payload.get("status") == "FAIL" and not payload.get("blocker_finding_ids"):
                errors.append(f"quality-gate tier {tier_name} FAIL has no blocker_finding_ids")

    render_check = render_bundle(audit_dir, stage, check=True)
    for relpath in render_check["mismatches"]:
        errors.append(f"deterministic render drift: {relpath}")

    write_bundle_verdict(audit_dir, stage, errors)

    return {
        "ok": len(errors) == 0,
        "stage": stage,
        "errors": errors,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("Usage: report_contract.py <phase-docs|manifest|validate> <audit_dir> [stage]")
        return 1

    command = argv[1]
    audit_dir = argv[2]
    if command == "phase-docs":
        written = generate_phase_docs(audit_dir)
        print(f"Generated {len(written)} phase docs")
        return 0
    if command == "manifest":
        generate_report_manifest(audit_dir)
        print("Generated report-manifest.json")
        return 0
    if command == "validate":
        stage = argv[3] if len(argv) > 3 else "rinnegan"
        result = validate_publication_contract(audit_dir, stage=stage)
        if result["ok"]:
            print(f"PUBLICATION_VALID: {stage}")
            return 0
        print(f"PUBLICATION_INVALID: {stage}")
        for error in result["errors"]:
            print(f"- {error}")
        return 1

    print(f"Unknown command: {command}")
    return 1


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
