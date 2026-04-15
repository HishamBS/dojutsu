"""Compute deterministic audit statistics from pipeline data files.

Generates audit-stats.json -- the single source of truth for all numbers
that appear in generated reports. LLM generators MUST use these pre-computed
values instead of counting from raw data themselves.
"""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# SSOT mappings (R01) -- defined once, used by all consumers
# ---------------------------------------------------------------------------

PHASE_NAMES: dict[int, str] = {
    0: "Foundation / Build",
    1: "Security",
    2: "Typing Discipline",
    3: "SSOT / DRY",
    4: "Architecture / Layering",
    5: "Clean Code",
    6: "Performance",
    7: "Data Integrity",
    8: "Refactoring",
    9: "Full-Stack Alignment",
    10: "Documentation",
}

RULE_NAMES: dict[str, str] = {
    "R01": "SSOT & DRY",
    "R02": "Separation of Concerns",
    "R03": "Mirror Architecture",
    "R04": "Performance First",
    "R05": "Security",
    "R07": "Strict Typing",
    "R08": "Build/Test Gate",
    "R09": "Clean Code",
    "R10": "Whole-System Refactors",
    "R11": "Documentation",
    "R12": "Real Data",
    "R13": "No Magic Numbers",
    "R14": "Clean Build",
    "R16": "Full Stack Verification",
}

# Severity levels in canonical order
SEVERITY_LEVELS: list[str] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"]


# ---------------------------------------------------------------------------
# File loaders
# ---------------------------------------------------------------------------


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    """Load a JSONL file into a list of dicts. Returns [] if missing."""
    items: list[dict[str, Any]] = []
    if not os.path.isfile(path):
        return items
    with open(path) as fh:
        for line in fh:
            stripped = line.strip()
            if stripped:
                items.append(json.loads(stripped))
    return items


def _load_json(path: str) -> dict[str, Any] | None:
    """Load a JSON file. Returns None if missing or malformed."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as fh:
            return json.load(fh)  # type: ignore[no-any-return]
    except (json.JSONDecodeError, OSError):
        return None


# ---------------------------------------------------------------------------
# Stat computation helpers
# ---------------------------------------------------------------------------


def _severity_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    """Count findings per severity level, always including all levels."""
    counter: Counter[str] = Counter()
    for f in findings:
        counter[f.get("severity", "MEDIUM")] += 1
    return {level: counter.get(level, 0) for level in SEVERITY_LEVELS}


def _category_breakdown(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group findings by category with per-severity sub-counts, sorted by count desc."""
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in findings:
        cat = f.get("category", "uncategorized")
        by_cat[cat].append(f)

    result: list[dict[str, Any]] = []
    for cat_name, members in by_cat.items():
        sev_counts: Counter[str] = Counter()
        for m in members:
            sev_counts[m.get("severity", "MEDIUM")] += 1
        result.append({
            "name": cat_name,
            "count": len(members),
            "critical": sev_counts.get("CRITICAL", 0),
            "high": sev_counts.get("HIGH", 0),
            "medium": sev_counts.get("MEDIUM", 0),
            "low": sev_counts.get("LOW", 0),
            "review": sev_counts.get("REVIEW", 0),
        })
    return sorted(result, key=lambda x: x["count"], reverse=True)


def _layer_breakdown(
    findings: list[dict[str, Any]],
    inventory: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Group findings by layer with file count, LOC, and density."""
    layers_inv: dict[str, Any] = (inventory or {}).get("layers", {})

    by_layer: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in findings:
        layer = f.get("layer", "unknown")
        by_layer[layer].append(f)

    result: list[dict[str, Any]] = []
    for layer_name, members in by_layer.items():
        layer_data = layers_inv.get(layer_name, {})
        files_list: list[str] = layer_data.get("files", [])
        loc: int = layer_data.get("loc", 0)
        density = round(len(members) / max(loc / 1000.0, 0.1), 1) if loc > 0 else 0.0
        result.append({
            "name": layer_name,
            "files": len(files_list),
            "loc": loc,
            "findings": len(members),
            "density_per_kloc": density,
        })
    return sorted(result, key=lambda x: x["findings"], reverse=True)


def _phase_breakdown(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group findings by phase with severity sub-counts."""
    by_phase: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for f in findings:
        phase = f.get("phase", 0)
        if isinstance(phase, str):
            try:
                phase = int(phase)
            except ValueError:
                phase = 0
        by_phase[phase].append(f)

    result: list[dict[str, Any]] = []
    for phase_num in sorted(by_phase.keys()):
        members = by_phase[phase_num]
        sev_counts: Counter[str] = Counter()
        for m in members:
            sev_counts[m.get("severity", "MEDIUM")] += 1
        result.append({
            "phase": phase_num,
            "name": PHASE_NAMES.get(phase_num, f"Phase {phase_num}"),
            "findings": len(members),
            "critical": sev_counts.get("CRITICAL", 0),
            "high": sev_counts.get("HIGH", 0),
        })
    return result


def _hotspots(findings: list[dict[str, Any]], limit: int = 10) -> list[dict[str, str | int]]:
    """Top N files by finding count."""
    by_file: Counter[str] = Counter()
    for f in findings:
        by_file[f.get("file", "unknown")] += 1
    return [
        {"file": name, "findings": count}
        for name, count in by_file.most_common(limit)
    ]


def _cross_cutting_stats(findings: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate cross-cutting stats from pre-computed cross_cutting fields."""
    groups: set[str] = set()
    in_group_count = 0
    for f in findings:
        if f.get("cross_cutting"):
            in_group_count += 1
            group_name = f.get("cross_cutting_group", "")
            if group_name:
                groups.add(group_name)
    total = len(findings)
    pct = round(in_group_count / max(total, 1) * 100, 1)
    return {
        "total_findings_in_groups": in_group_count,
        "total_groups": len(groups),
        "percent_cross_cutting": pct,
    }


def _enrichment_stats(findings: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute enrichment coverage stats."""
    has_target = 0
    has_fix = 0
    has_either = 0
    has_neither = 0
    for f in findings:
        t = bool(f.get("current_code") or f.get("target_code"))
        fp = bool(f.get("fix_plan"))
        if t:
            has_target += 1
        if fp:
            has_fix += 1
        if t or fp:
            has_either += 1
        else:
            has_neither += 1
    total = len(findings)
    rate = round(has_either / max(total, 1) * 100, 1)
    return {
        "has_target_code": has_target,
        "has_fix_plan": has_fix,
        "has_either": has_either,
        "has_neither": has_neither,
        "enrichment_rate_percent": rate,
    }


def _scanner_breakdown(findings: list[dict[str, Any]]) -> list[dict[str, str | int]]:
    """Count findings per scanner, sorted by count desc."""
    by_scanner: Counter[str] = Counter()
    for f in findings:
        by_scanner[f.get("scanner", "unknown")] += 1
    return [
        {"name": name, "count": count}
        for name, count in by_scanner.most_common()
    ]


def _rule_breakdown(findings: list[dict[str, Any]]) -> list[dict[str, str | int]]:
    """Count findings per rule with human-readable name, sorted by count desc."""
    by_rule: Counter[str] = Counter()
    for f in findings:
        by_rule[f.get("rule", "UNKNOWN")] += 1
    return [
        {
            "rule": rule,
            "count": count,
            "name": RULE_NAMES.get(rule, rule),
        }
        for rule, count in by_rule.most_common()
    ]


def _affected_file_count(findings: list[dict[str, Any]]) -> int:
    return len({str(f.get("file", "")) for f in findings if str(f.get("file", ""))})


def _cluster_stats(audit_dir: str) -> dict[str, Any]:
    clusters = _load_json(os.path.join(audit_dir, "deep", "clusters.json")) or {}
    items = clusters.get("clusters", [])
    if not isinstance(items, list):
        items = []
    return {
        "total_clusters": len(items),
        "ids": [str(cluster.get("id", "")) for cluster in items if str(cluster.get("id", ""))],
    }


def _family_stats(audit_dir: str) -> dict[str, Any]:
    families = _load_json(os.path.join(audit_dir, "data", "finding-families.json")) or {}
    summary = families.get("summary", {})
    if not isinstance(summary, dict):
        summary = {}
    return {
        "families_created": int(summary.get("families_created", 0)),
        "root_causes": int(summary.get("root_causes", 0)),
        "subordinate_findings": int(summary.get("subordinate_findings", 0)),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_stats(audit_dir: str) -> dict[str, Any]:
    """Compute all deterministic statistics from audit data files.

    Reads:
        - ``data/findings.jsonl`` -- all findings
        - ``data/inventory.json`` -- file inventory
        - ``data/pipeline-health.json`` -- tool scanner results
        - ``data/quality-gate.json`` -- readiness score
        - ``data/config.json`` -- project metadata only (if exists)

    Returns a dict with every number a report generator might need.
    """
    data_dir = os.path.join(audit_dir, "data")

    # Load data files
    findings = _load_jsonl(os.path.join(data_dir, "findings.jsonl"))
    inventory = _load_json(os.path.join(data_dir, "inventory.json"))
    health = _load_json(os.path.join(data_dir, "pipeline-health.json"))
    quality_gate = _load_json(os.path.join(data_dir, "quality-gate.json"))
    config = _load_json(os.path.join(data_dir, "config.json"))

    # Project metadata
    inv = inventory or {}
    project_name: str = inv.get("root", "unknown")
    stack: str = (config or {}).get("stack", inv.get("stack", "unknown"))
    framework: str = (config or {}).get("framework", inv.get("framework", "unknown"))
    total_files: int = inv.get("total_files", 0)
    total_loc: int = inv.get("total_loc", 0)

    now = datetime.now(timezone.utc)

    stats: dict[str, Any] = {
        # Timestamps
        "generated_at": now.isoformat(),
        "audit_date": date.today().isoformat(),
        # Project metadata
        "project_name": project_name,
        "stack": stack,
        "framework": framework,
        "total_files": total_files,
        "total_loc": total_loc,
        # Finding totals
        "total_findings": len(findings),
        "total_raw_findings": len(findings),
        "dedup_count": 0,
        "affected_files": _affected_file_count(findings),
        # Severity breakdown
        "severity": _severity_counts(findings),
        # Category breakdown
        "categories": _category_breakdown(findings),
        # Layer breakdown
        "layers": _layer_breakdown(findings, inventory),
        # Phase breakdown
        "phases": _phase_breakdown(findings),
        # Hotspots
        "hotspots": _hotspots(findings),
        # Cross-cutting
        "cross_cutting": _cross_cutting_stats(findings),
        # Quality gate
        "quality_gate": quality_gate or {},
        # Pipeline health
        "pipeline_health": health or {},
        # Enrichment
        "enrichment": _enrichment_stats(findings),
        # Scanner breakdown
        "scanners": _scanner_breakdown(findings),
        # Rule breakdown
        "rules": _rule_breakdown(findings),
        # Cluster and family rollups
        "clusters": _cluster_stats(audit_dir),
        "families": _family_stats(audit_dir),
    }

    return stats


def write_stats(audit_dir: str) -> str:
    """Compute stats and write to ``{audit_dir}/data/audit-stats.json``.

    Returns the path to the written file.
    """
    stats = compute_stats(audit_dir)
    output_path = os.path.join(audit_dir, "data", "audit-stats.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as fh:
        json.dump(stats, fh, indent=2)
        fh.write("\n")
    return output_path


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: compute_audit_stats.py <audit_dir>")
        sys.exit(1)
    path = write_stats(sys.argv[1])
    print(f"Stats written to {path}")
