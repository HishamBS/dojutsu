#!/usr/bin/env python3
"""Compile deterministic audit bundle documents from SSOT data files."""
from __future__ import annotations

import hashlib
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from run_pipeline_lib import PHASE_FILE_SLUGS, SPEC_PHASE_NODES


RINNEGAN_OUTPUTS = (
    "master-audit.md",
    "cross-cutting.md",
    "progress.md",
    "agent-instructions.md",
)

BYAKUGAN_OUTPUTS = (
    "deep/narrative.md",
    "deep/scorecard.md",
    "deep/deployment-plan.md",
    "deep/executive-brief.md",
)

SEVERITY_ORDER = {
    "CRITICAL": 0,
    "HIGH": 1,
    "MEDIUM": 2,
    "LOW": 3,
    "REVIEW": 4,
}

SEVERITY_WEIGHTS = {
    "CRITICAL": 10.0,
    "HIGH": 3.0,
    "MEDIUM": 1.0,
    "LOW": 0.2,
    "REVIEW": 0.0,
}


def _load_json(path: str) -> dict[str, Any]:
    if not os.path.isfile(path):
        return {}
    with open(path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not os.path.isfile(path):
        return rows
    with open(path) as fh:
        for raw_line in fh:
            stripped = raw_line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def _existing_generated_at(audit_dir: str) -> str | None:
    bundle_model = _load_json(os.path.join(audit_dir, "data", "bundle-model.json"))
    generated_at = bundle_model.get("generated_at")
    if isinstance(generated_at, str) and generated_at.strip():
        return generated_at
    return None


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _percent(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round((numerator / denominator) * 100.0, 1)


def _severity_key(finding: dict[str, Any]) -> tuple[int, str, int, str]:
    line = finding.get("line", 0)
    try:
        line_num = int(line)
    except (TypeError, ValueError):
        line_num = 0
    return (
        SEVERITY_ORDER.get(str(finding.get("severity", "MEDIUM")), 99),
        str(finding.get("file", "")),
        line_num,
        str(finding.get("id", "")),
    )


def _phase_name(phase_id: int) -> str:
    for node in SPEC_PHASE_NODES:
        if node["id"] == phase_id:
            return str(node["name"])
    return f"Phase {phase_id}"


def _canonical_phase_path(phase_id: int) -> str:
    return f"phases/phase-{phase_id}-{PHASE_FILE_SLUGS[phase_id]}.md"


def _code_block(value: str | None, language: str) -> str:
    content = value or ""
    return f"```{language}\n{content.rstrip()}\n```"


def _lang_for_file(path: str) -> str:
    if path.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")):
        return "ts"
    if path.endswith(".py"):
        return "python"
    if path.endswith((".java", ".kt", ".kts")):
        return "java"
    if path.endswith(".go"):
        return "go"
    return ""


def _slug_anchor(text: str) -> str:
    lowered = text.lower()
    normalized = []
    previous_dash = False
    for char in lowered:
        if char.isalnum():
            normalized.append(char)
            previous_dash = False
        elif not previous_dash:
            normalized.append("-")
            previous_dash = True
    return "".join(normalized).strip("-")


def _must_fix_ids(findings: list[dict[str, Any]]) -> list[str]:
    ordered = sorted(findings, key=_severity_key)
    return [
        str(finding.get("id", ""))
        for finding in ordered
        if str(finding.get("severity", "")) in ("CRITICAL", "HIGH") or finding.get("is_root_cause") is True
    ]


def _recommendation_from_gate(quality_gate: dict[str, Any], must_fix_count: int) -> str:
    overall = str(quality_gate.get("overall", "FAIL"))
    if overall == "FAIL":
        return (
            f"Do not begin remediation until the {must_fix_count} must-fix findings are assigned by phase and "
            "the published bundle remains validator-clean after every rerender."
        )
    if overall == "CONDITIONAL":
        return (
            f"Proceed with remediation, but keep must-fix work ahead of code-hygiene cleanup. "
            f"{must_fix_count} findings still require deliberate sequencing."
        )
    return "The bundle is internally consistent. Use phase tasks and cluster guidance to remediate in order."


def build_bundle_model(audit_dir: str) -> dict[str, Any]:
    data_dir = os.path.join(audit_dir, "data")
    deep_dir = os.path.join(audit_dir, "deep")

    findings = _load_jsonl(os.path.join(data_dir, "findings.jsonl"))
    inventory = _load_json(os.path.join(data_dir, "inventory.json"))
    stats = _load_json(os.path.join(data_dir, "audit-stats.json"))
    quality_gate = _load_json(os.path.join(data_dir, "quality-gate.json"))
    families = _load_json(os.path.join(data_dir, "finding-families.json"))
    clusters = _load_json(os.path.join(deep_dir, "clusters.json"))
    impact_rows = _load_jsonl(os.path.join(deep_dir, "impact-analysis.jsonl"))
    report_manifest = _load_json(os.path.join(data_dir, "report-manifest.json"))

    findings_sorted = sorted(findings, key=_severity_key)
    findings_by_layer: dict[str, list[dict[str, Any]]] = defaultdict(list)
    findings_by_phase: dict[int, list[dict[str, Any]]] = defaultdict(list)
    cross_cutting: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_id = {str(finding.get("id", "")): finding for finding in findings_sorted}

    for finding in findings_sorted:
        findings_by_layer[str(finding.get("layer", "misc"))].append(finding)
        phase = finding.get("phase", 10)
        try:
            phase_id = int(phase)
        except (TypeError, ValueError):
            phase_id = 10
        findings_by_phase[phase_id].append(finding)
        if finding.get("cross_cutting") and finding.get("cross_cutting_group"):
            cross_cutting[str(finding["cross_cutting_group"])].append(finding)

    impacted_files = sorted({str(finding.get("file", "")) for finding in findings_sorted if str(finding.get("file", ""))})
    total_loc = int(stats.get("total_loc", inventory.get("total_loc", 0) or 0))
    weighted_score = sum(SEVERITY_WEIGHTS.get(str(finding.get("severity", "LOW")), 0.0) for finding in findings_sorted)
    kloc = max(total_loc / 1000.0, 1.0)
    readiness = round(max(0.0, min(100.0, 100.0 - (weighted_score / kloc))), 2)

    phase_docs: list[dict[str, Any]] = []
    for node in SPEC_PHASE_NODES:
        phase_id = int(node["id"])
        task_payload = _load_json(os.path.join(data_dir, "tasks", f"phase-{phase_id}-tasks.json"))
        phase_docs.append(
            {
                "phase": phase_id,
                "name": _phase_name(phase_id),
                "path": _canonical_phase_path(phase_id),
                "tasks": int(task_payload.get("total_tasks", len(task_payload.get("tasks", [])))),
                "status": task_payload.get("status", "clear" if phase_id not in findings_by_phase else "not_started"),
            }
        )

    cluster_entries = clusters.get("clusters", []) if isinstance(clusters.get("clusters"), list) else []
    cluster_index = {str(cluster.get("id", "")): cluster for cluster in cluster_entries if str(cluster.get("id", ""))}
    impact_by_cluster: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in impact_rows:
        cluster_id = str(row.get("cluster_id", ""))
        if cluster_id:
            impact_by_cluster[cluster_id].append(row)

    cluster_summaries: list[dict[str, Any]] = []
    for cluster in cluster_entries:
        cluster_id = str(cluster.get("id", ""))
        rows = sorted(impact_by_cluster.get(cluster_id, []), key=lambda row: (
            SEVERITY_ORDER.get(str(by_id.get(str(row.get("finding_id", "")), {}).get("severity", "MEDIUM")), 99),
            str(row.get("finding_id", "")),
        ))
        cluster_summaries.append(
            {
                "id": cluster_id,
                "name": str(cluster.get("name", "")),
                "type": str(cluster.get("type", "")),
                "rules": list(cluster.get("rules", [])),
                "finding_count": int(cluster.get("finding_count", len(cluster.get("finding_ids", [])))),
                "max_severity": str(cluster.get("max_severity", "LOW")),
                "root_pattern": str(cluster.get("root_pattern", "")),
                "files": list(cluster.get("files", [])),
                "finding_ids": list(cluster.get("finding_ids", [])),
                "impact_rows": rows,
                "cluster_narrative": rows[0].get("cluster_narrative", {}) if rows else {},
                "recommended_approach": rows[0].get("recommended_approach", {}) if rows else {},
            }
        )

    blocker_ids: dict[str, list[str]] = {}
    for tier_name, payload in (quality_gate.get("tiers") or {}).items():
        if isinstance(payload, dict):
            blocker_ids[tier_name] = [str(item) for item in payload.get("blocker_finding_ids", [])]

    layer_docs = []
    for layer_name, members in sorted(findings_by_layer.items(), key=lambda item: (-len(item[1]), item[0])):
        layer_inventory = (inventory.get("layers") or {}).get(layer_name, {})
        layer_docs.append(
            {
                "name": layer_name,
                "files": list(layer_inventory.get("files", [])),
                "loc": int(layer_inventory.get("loc", 0)),
                "findings": members,
                "path": f"layers/{layer_name}.md",
            }
        )

    model = {
        "generated_at": _existing_generated_at(audit_dir) or datetime.now(timezone.utc).isoformat(),
        "project_name": stats.get("project_name", inventory.get("root", "unknown")),
        "stack": stats.get("stack", inventory.get("stack", "unknown")),
        "framework": stats.get("framework", inventory.get("framework", "unknown")),
        "total_files_scanned": int(stats.get("total_files", inventory.get("total_files", 0) or 0)),
        "total_loc": total_loc,
        "total_findings": len(findings_sorted),
        "affected_files": impacted_files,
        "affected_file_count": len(impacted_files),
        "severity": stats.get("severity", {}),
        "categories": stats.get("categories", []),
        "layers": layer_docs,
        "phases": phase_docs,
        "cross_cutting_groups": [
            {
                "name": group_name,
                "instances": members,
                "count": len(members),
                "layers": sorted({str(member.get("layer", "")) for member in members}),
                "highest_severity": min(
                    (str(member.get("severity", "LOW")) for member in members),
                    key=lambda severity: SEVERITY_ORDER.get(severity, 99),
                    default="LOW",
                ),
                "rule": str(members[0].get("rule", "")) if members else "",
            }
            for group_name, members in sorted(cross_cutting.items(), key=lambda item: (-len(item[1]), item[0]))
        ],
        "critical_findings": [finding for finding in findings_sorted if str(finding.get("severity", "")) == "CRITICAL"],
        "must_fix_ids": _must_fix_ids(findings_sorted),
        "quality_gate": quality_gate,
        "blocker_finding_ids": blocker_ids,
        "families": families.get("families", []),
        "clusters": cluster_summaries,
        "report_manifest": report_manifest,
        "readiness_score": readiness,
        "finding_index": by_id,
        "cluster_index": cluster_index,
        "impact_rows": impact_rows,
    }
    return model


def _render_master_audit(model: dict[str, Any]) -> str:
    severity = model["severity"]
    total_findings = max(int(model["total_findings"]), 1)
    lines = [
        f"# {model['project_name']} Codebase Audit",
        "",
        f"> **Date:** {str(model['generated_at'])[:10]} | **Stack:** {model['stack']} ({model['framework']})",
        f"> **Files:** {model['total_files_scanned']} | **LOC:** {model['total_loc']} | **Findings:** {model['total_findings']}",
        f"> **Affected files:** {model['affected_file_count']} | **Readiness:** {model['readiness_score']}%",
        "",
        "## Executive Summary",
        "",
        "### Severity Distribution",
        "",
        "| Severity | Count | % |",
        "|----------|------:|--:|",
    ]
    for level in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"):
        count = int(severity.get(level, 0))
        lines.append(f"| {level} | {count} | {_percent(count, total_findings)}% |")

    lines.extend(["", "### All Critical Findings", ""])
    criticals = model["critical_findings"]
    if criticals:
        for index, finding in enumerate(criticals, start=1):
            layer = str(finding.get("layer", "misc"))
            lines.append(
                f"{index}. **[{finding['id']}](layers/{layer}.md#{_slug_anchor(str(finding['id']))})** "
                f"`{finding.get('file', '')}:{finding.get('line', '')}` -- {finding.get('description', '')}"
            )
    else:
        lines.append("No CRITICAL findings are present in the published bundle.")

    lines.extend(["", "### Category Breakdown", "", "| Category | Count | |", "|----------|------:|-|"])
    for category in model["categories"]:
        lines.append(f"| {category['name']} | {category['count']} | |")

    lines.extend(["", "## Layer Audit Index", "", "| Layer | Files | LOC | Findings | Audit Doc |", "|-------|------:|----:|---------:|-----------|"])
    for layer in model["layers"]:
        lines.append(
            f"| {layer['name']} | {len(layer['files'])} | {layer['loc']} | {len(layer['findings'])} | "
            f"[{layer['name']}.md]({layer['path']}) |"
        )

    lines.extend(
        [
            "",
            "## Cross-Cutting Patterns",
            "",
            f"See [cross-cutting.md](cross-cutting.md) for {len(model['cross_cutting_groups'])} patterns spanning multiple layers.",
            "",
            "## Remediation Phases",
            "",
            "| Phase | Name | Findings | Status | Phase Doc |",
            "|-------|------|---------:|--------|-----------|",
        ]
    )
    findings_by_phase = Counter(int(finding.get("phase", 10)) for finding in model["finding_index"].values())
    for phase in model["phases"]:
        lines.append(
            f"| {phase['phase']} | {phase['name']} | {findings_by_phase.get(int(phase['phase']), 0)} | "
            f"{phase['status']} | [phase-{phase['phase']}]({phase['path']}) |"
        )

    lines.extend(["", "## Phase Dependency DAG", ""])
    for node in SPEC_PHASE_NODES:
        phase_id = int(node["id"])
        lines.append(
            f"- Phase {phase_id}: {node['name']} ({', '.join(node['rules'])}) — "
            f"{findings_by_phase.get(phase_id, 0)} findings"
        )

    lines.extend(
        [
            "",
            "## How to Use This Audit",
            "",
            "1. Start with this document for the severity split and phase order.",
            "2. Read layer docs for file-level evidence and target fixes.",
            "3. Use cross-cutting.md for repeated patterns that share one remediation path.",
            "4. Use phase docs and task JSON files to execute fixes in order.",
            "",
        ]
    )
    return "\n".join(lines)


def _render_layer_doc(model: dict[str, Any], layer: dict[str, Any]) -> str:
    findings = layer["findings"]
    lines = [
        f"# {layer['name']} Layer Audit",
        "",
        f"> **Service:** {model['project_name']} | **Layer:** {layer['name']}",
        f"> **Files:** {len(layer['files'])} | **LOC:** {layer['loc']} | **Findings:** {len(findings)}",
        "",
        "## Findings Summary",
        "",
        "| ID | Line | Severity | Rule | Description |",
        "|----|-----:|----------|------|-------------|",
    ]
    for finding in findings:
        lines.append(
            f"| {finding.get('id', '')} | {finding.get('line', '')} | {finding.get('severity', '')} | "
            f"{finding.get('rule', '')} | {finding.get('description', '')} |"
        )

    lines.extend(["", "## Findings", ""])
    for finding in findings:
        file_path = str(finding.get("file", ""))
        language = _lang_for_file(file_path)
        lines.extend(
            [
                f"### {finding.get('id', '')}",
                "",
                f"<a id=\"{_slug_anchor(str(finding.get('id', '')))}\"></a>",
                "",
                f"- File: `{file_path}:{finding.get('line', '')}`",
                f"- Severity: `{finding.get('severity', '')}`",
                f"- Rule: `{finding.get('rule', '')}`",
                f"- Effort: `{finding.get('effort', '')}`",
                f"- Phase: `{finding.get('phase', '')}`",
                f"- Explanation: {finding.get('explanation', '')}",
                "",
                "**Current code**",
                _code_block(str(finding.get("current_code", finding.get("snippet", ""))), language),
                "",
                "**Target code**",
                _code_block(str(finding.get("target_code", "")), language),
                "",
            ]
        )
        fix_plan = finding.get("fix_plan")
        if isinstance(fix_plan, list) and fix_plan:
            lines.extend(["**Fix plan**", ""])
            for step in fix_plan:
                lines.append(
                    f"- `{step.get('action', 'edit')}` `{step.get('file', '')}` — {step.get('description', '')}"
                )
            lines.append("")
    return "\n".join(lines)


def _render_cross_cutting(model: dict[str, Any]) -> str:
    lines = ["# Cross-Cutting Patterns", ""]
    groups = model["cross_cutting_groups"]
    if not groups:
        lines.extend(["No cross-cutting patterns detected.", ""])
        return "\n".join(lines)

    for group in groups:
        lines.extend(
            [
                f"## Pattern: {group['name']}",
                "",
                f"**Rule:** {group['rule']} | **Instances:** {group['count']} across {len(group['layers'])} layers | "
                f"**Severity:** {group['highest_severity']}",
                "",
                "| # | File | Line | Layer | Finding |",
                "|---|------|-----:|-------|---------|",
            ]
        )
        for index, finding in enumerate(group["instances"], start=1):
            lines.append(
                f"| {index} | `{finding.get('file', '')}` | {finding.get('line', '')} | "
                f"{finding.get('layer', '')} | {finding.get('description', '')} |"
            )
        lines.extend(
            [
                "",
                f"Root-cause guidance: resolve `{group['name']}` once and apply the same abstraction across all listed files.",
                "",
            ]
        )
    return "\n".join(lines)


def _render_progress(model: dict[str, Any]) -> str:
    lines = [
        "# Progress",
        "",
        f"- Generated at: `{model['generated_at']}`",
        f"- Audit readiness: `{model['quality_gate'].get('overall', 'FAIL')}` ({model['readiness_score']}%)",
        f"- Must-fix findings: `{len(model['must_fix_ids'])}`",
        "",
        "| Phase | Name | Findings | Status |",
        "|-------|------|---------:|--------|",
    ]
    findings_by_phase = Counter(int(finding.get("phase", 10)) for finding in model["finding_index"].values())
    for phase in model["phases"]:
        lines.append(
            f"| {phase['phase']} | {phase['name']} | {findings_by_phase.get(int(phase['phase']), 0)} | {phase['status']} |"
        )
    lines.append("")
    return "\n".join(lines)


def _render_agent_instructions(model: dict[str, Any]) -> str:
    lines = [
        "# Agent Instructions",
        "",
        "Use only the published SSOT files below when planning remediation:",
        "",
        "- `data/findings.jsonl` — canonical findings, severities, cluster IDs, root-cause links",
        "- `data/audit-stats.json` — canonical aggregate metrics",
        "- `data/quality-gate.json` — canonical blocker tiers and finding IDs",
        "- `data/tasks/phase-N-tasks.json` — canonical execution tasks per phase",
        "- `deep/clusters.json` — canonical cluster taxonomy",
        "",
        f"Must-fix finding IDs: {', '.join(model['must_fix_ids']) if model['must_fix_ids'] else 'none'}",
        "",
    ]
    return "\n".join(lines)


def _render_executive_brief(model: dict[str, Any]) -> str:
    severity = model["severity"]
    criticals = model["critical_findings"]
    top_risks = criticals[:3] if criticals else sorted(model["finding_index"].values(), key=_severity_key)[:3]
    lines = [
        f"# Executive Brief: {model['project_name']}",
        "",
        f"**Date:** {str(model['generated_at'])[:10]} | **Stack:** {model['stack']} ({model['framework']}) | "
        f"**Readiness:** {model['readiness_score']}%",
        "",
        "## Summary",
        "",
        f"This audit published {model['total_findings']} findings across {model['affected_file_count']} affected files. "
        f"The current quality gate verdict is {model['quality_gate'].get('overall', 'FAIL')}. "
        f"{len(model['must_fix_ids'])} findings are in the must-fix set before remediation should begin.",
        "",
        "## Severity",
        "",
        f"- CRITICAL: {severity.get('CRITICAL', 0)}",
        f"- HIGH: {severity.get('HIGH', 0)}",
        f"- MEDIUM: {severity.get('MEDIUM', 0)}",
        f"- LOW: {severity.get('LOW', 0)}",
        f"- REVIEW: {severity.get('REVIEW', 0)}",
        "",
        "## Top Risks",
        "",
    ]
    for index, finding in enumerate(top_risks, start=1):
        lines.append(
            f"{index}. **{finding.get('id', '')}** ({finding.get('severity', '')}) — {finding.get('description', '')}"
        )
    lines.extend(["", "## Recommendation", "", _recommendation_from_gate(model["quality_gate"], len(model["must_fix_ids"])), ""])
    return "\n".join(lines)


def _render_scorecard(model: dict[str, Any]) -> str:
    rules = sorted({str(finding.get("rule", "")) for finding in model["finding_index"].values() if str(finding.get("rule", ""))})
    lines = ["# Compliance Scorecard", "", "## Per-Layer Compliance Matrix", ""]
    header = "| Layer | Files | LOC | " + " | ".join(rules) + " |"
    divider = "|------|------:|----:|" + "|".join("---" for _ in rules) + "|"
    lines.extend([header, divider])
    for layer in model["layers"]:
        counts = Counter(str(finding.get("rule", "")) for finding in layer["findings"])
        cells = []
        for rule in rules:
            count = counts.get(rule, 0)
            if count == 0:
                cells.append("PASS")
            elif count <= 5:
                cells.append(f"WARN({count})")
            else:
                cells.append(f"FAIL({count})")
        lines.append(f"| {layer['name']} | {len(layer['files'])} | {layer['loc']} | " + " | ".join(cells) + " |")

    lines.extend(["", "## Key Metrics", ""])
    lines.append(f"- Finding density: {round(model['total_findings'] / max(model['total_loc'] / 1000.0, 0.1), 1)} per KLOC")
    lines.append(f"- Readiness: {model['readiness_score']}%")
    lines.append(f"- Cluster count: {len(model['clusters'])}")
    lines.append(f"- Root-cause families: {len(model['families'])}")
    lines.extend(["", "## Top Systemic Patterns", ""])
    for cluster in model["clusters"][:5]:
        lines.append(
            f"- **{cluster['id']}** {cluster['name']} — {cluster['finding_count']} findings, "
            f"{cluster['max_severity']}, rules: {', '.join(cluster['rules']) or 'n/a'}"
        )
    lines.append("")
    return "\n".join(lines)


def _render_deployment_plan(model: dict[str, Any]) -> str:
    must_fix = [model["finding_index"][finding_id] for finding_id in model["must_fix_ids"] if finding_id in model["finding_index"]]
    lines = ["# Deployment Plan", "", "## Pre-Merge Checklist", ""]
    if not must_fix:
        lines.extend(["No HIGH or CRITICAL findings detected. Standard deployment process applies.", ""])
        return "\n".join(lines)
    for finding in must_fix:
        lines.append(f"- [ ] {finding.get('id', '')}: {finding.get('description', '')} ({finding.get('severity', '')})")
    lines.extend(["", "## Suggested Fix Order", ""])
    findings_by_phase = Counter(int(finding.get("phase", 10)) for finding in must_fix)
    for phase in model["phases"]:
        phase_id = int(phase["phase"])
        if findings_by_phase.get(phase_id, 0) <= 0:
            continue
        lines.append(f"{phase_id}. {phase['name']} — {findings_by_phase.get(phase_id, 0)} must-fix findings")
    lines.extend(
        [
            "",
            "## Rollback Plan",
            "",
            "Use standard git revert on the remediation commits for the affected phase if post-deploy verification fails.",
            "",
            "## Smoke Tests",
            "",
            "- [ ] Build and type-check pass",
            "- [ ] Critical user paths tied to must-fix findings are manually verified",
            "- [ ] Security-sensitive endpoints regressions are checked before rollout",
            "",
        ]
    )
    return "\n".join(lines)


def _render_narrative(model: dict[str, Any]) -> str:
    lines = [
        f"# {model['project_name']} Technical Audit Narrative",
        "",
        "## Executive Summary",
        "",
        f"The published bundle contains {model['total_findings']} findings across {model['affected_file_count']} affected files. "
        f"{len(model['clusters'])} deterministic clusters were produced and {len(model['families'])} root-cause families were collapsed before publication. "
        f"The quality gate verdict is {model['quality_gate'].get('overall', 'FAIL')}.",
        "",
        "## Cluster Analysis",
        "",
    ]
    for cluster in model["clusters"]:
        narrative = cluster.get("cluster_narrative") or {}
        approach = cluster.get("recommended_approach") or {}
        lines.extend(
            [
                f"### {cluster['id']}: {cluster['name']}",
                "",
                f"- Type: `{cluster['type']}`",
                f"- Findings: `{cluster['finding_count']}`",
                f"- Max severity: `{cluster['max_severity']}`",
                f"- Root pattern: {cluster['root_pattern'] or 'n/a'}",
                f"- Root cause: {narrative.get('root_cause', 'No structured root cause provided.')}",
                f"- Systemic pattern: {narrative.get('systemic_pattern', 'No structured pattern provided.')}",
                f"- Business impact: {narrative.get('business_impact', 'No structured business impact provided.')}",
                f"- Recommended strategy: {approach.get('strategy', 'n/a')}",
                "",
            ]
        )
        if cluster["impact_rows"]:
            lines.append("| Finding | File | Line | Effective Severity |")
            lines.append("|---------|------|-----:|--------------------|")
            for row in cluster["impact_rows"]:
                lines.append(
                    f"| {row.get('finding_id', '')} | `{row.get('file', '')}` | {row.get('line', '')} | "
                    f"{row.get('effective_severity', '')} |"
                )
            lines.append("")

    lines.extend(["## Overall Verdict", "", _recommendation_from_gate(model["quality_gate"], len(model["must_fix_ids"])), ""])
    return "\n".join(lines)


def render_bundle_outputs(audit_dir: str, stage: str) -> dict[str, str]:
    model = build_bundle_model(audit_dir)
    outputs: dict[str, str] = {
        "data/bundle-model.json": json.dumps(model, indent=2, sort_keys=False) + "\n",
        "master-audit.md": _render_master_audit(model),
        "cross-cutting.md": _render_cross_cutting(model),
        "progress.md": _render_progress(model),
        "agent-instructions.md": _render_agent_instructions(model),
    }

    for layer in model["layers"]:
        outputs[layer["path"]] = _render_layer_doc(model, layer)

    if stage == "byakugan":
        outputs["deep/executive-brief.md"] = _render_executive_brief(model)
        outputs["deep/scorecard.md"] = _render_scorecard(model)
        outputs["deep/deployment-plan.md"] = _render_deployment_plan(model)
        outputs["deep/narrative.md"] = _render_narrative(model)

    return outputs


def _normalize_content(content: str) -> str:
    normalized = content.rstrip()
    return normalized + "\n"


def render_bundle(audit_dir: str, stage: str, check: bool = False) -> dict[str, Any]:
    outputs = render_bundle_outputs(audit_dir, stage)
    mismatches: list[str] = []
    written: list[str] = []
    for relpath, content in outputs.items():
        abs_path = os.path.join(audit_dir, relpath)
        normalized = _normalize_content(content)
        if check:
            if not os.path.isfile(abs_path):
                mismatches.append(relpath)
                continue
            with open(abs_path) as fh:
                current = fh.read()
            if current != normalized:
                mismatches.append(relpath)
            continue
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "w") as fh:
            fh.write(normalized)
        written.append(relpath)
    return {"written": written, "mismatches": mismatches, "count": len(outputs)}


def write_bundle_verdict(audit_dir: str, stage: str, validation_errors: list[str]) -> dict[str, Any]:
    data_dir = os.path.join(audit_dir, "data")
    source_paths = [
        os.path.join(data_dir, "findings.jsonl"),
        os.path.join(data_dir, "audit-stats.json"),
        os.path.join(data_dir, "quality-gate.json"),
        os.path.join(data_dir, "report-manifest.json"),
        os.path.join(data_dir, "bundle-model.json"),
    ]
    if stage == "byakugan":
        source_paths.extend(
            [
                os.path.join(audit_dir, "deep", "clusters.json"),
                os.path.join(audit_dir, "deep", "impact-analysis.jsonl"),
            ]
        )
    hashes = {}
    for path in source_paths:
        if os.path.isfile(path):
            hashes[os.path.relpath(path, audit_dir)] = _sha256(path)
    verdict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "ok": len(validation_errors) == 0,
        "errors": validation_errors,
        "source_hashes": hashes,
    }
    verdict_path = os.path.join(data_dir, "bundle-verdict.json")
    os.makedirs(os.path.dirname(verdict_path), exist_ok=True)
    with open(verdict_path, "w") as fh:
        json.dump(verdict, fh, indent=2)
        fh.write("\n")
    return verdict


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("Usage: bundle_renderer.py <render|check> <audit_dir> <rinnegan|byakugan>")
        return 1
    command = argv[1]
    audit_dir = os.path.abspath(argv[2])
    stage = argv[3] if len(argv) > 3 else "rinnegan"
    if command == "render":
        result = render_bundle(audit_dir, stage, check=False)
        print(f"BUNDLE_RENDER_COMPLETE stage={stage} files={result['count']}")
        return 0
    if command == "check":
        result = render_bundle(audit_dir, stage, check=True)
        if result["mismatches"]:
            print(f"BUNDLE_RENDER_MISMATCH stage={stage}")
            for relpath in result["mismatches"]:
                print(f"- {relpath}")
            return 1
        print(f"BUNDLE_RENDER_VALID stage={stage}")
        return 0
    print(f"Unknown command: {command}")
    return 1


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
