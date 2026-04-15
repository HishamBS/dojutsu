#!/usr/bin/env python3
"""Merge per-cluster impact analysis artifacts into the published JSONL."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any


PARTS_DIRNAME = "impact-analysis-parts"
FINAL_FILENAME = "impact-analysis.jsonl"
MANIFEST_FILENAME = "impact-analysis-manifest.json"
REQUIRED_NARRATIVE_FIELDS = (
    "root_cause",
    "systemic_pattern",
    "business_impact",
    "why_it_exists",
)
REQUIRED_APPROACH_FIELDS = (
    "strategy",
    "description",
    "fix_order",
    "fix_blast_radius_files",
    "risk_assessment",
    "validation_steps",
)
VALID_STRATEGIES = {
    "extract_and_replace",
    "inline_fix",
    "refactor_pattern",
    "config_centralize",
    "wrap_and_deprecate",
}


def _load_json(path: str) -> dict[str, Any]:
    with open(path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _load_cluster_payload(path: str) -> dict[str, Any]:
    with open(path) as fh:
        raw = fh.read().strip()
    if not raw:
        raise ValueError(f"empty impact part: {path}")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if len(rows) == 1 and isinstance(rows[0], dict):
            payload = rows[0]
        else:
            raise ValueError(f"unsupported impact format in {path}")
    if not isinstance(payload, dict):
        raise ValueError(f"impact payload must be a JSON object: {path}")
    return payload


def _require_non_empty_string(payload: dict[str, Any], key: str, path: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"impact payload missing non-empty string '{key}': {path}")
    return value


def _require_string_list(payload: dict[str, Any], key: str, path: str) -> list[str]:
    value = payload.get(key)
    if not isinstance(value, list) or not value:
        raise ValueError(f"impact payload missing non-empty list '{key}': {path}")
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"impact payload has invalid string list '{key}': {path}")
        normalized.append(item)
    return normalized


def _validate_cluster_payload(payload: dict[str, Any], cluster_id: str, path: str) -> dict[str, Any]:
    if str(payload.get("cluster_id", "")).strip() != cluster_id:
        raise ValueError(f"impact payload cluster_id mismatch: {path}")

    _require_non_empty_string(payload, "cluster_label", path)
    _require_non_empty_string(payload, "analyzed_at", path)
    source_files = _require_string_list(payload, "source_files_read", path)

    read_count = payload.get("read_count")
    if not isinstance(read_count, int) or read_count < len(source_files):
        raise ValueError(f"impact payload has invalid read_count: {path}")

    findings = payload.get("findings")
    if not isinstance(findings, list) or not findings:
        raise ValueError(f"impact payload missing non-empty findings list: {path}")
    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError(f"impact payload findings must contain objects: {path}")
        _require_non_empty_string(finding, "finding_id", path)
        _require_non_empty_string(finding, "file", path)
        line = finding.get("line")
        if not isinstance(line, int) or line <= 0:
            raise ValueError(f"impact finding has invalid line: {path}")

    narrative = payload.get("cluster_narrative")
    if not isinstance(narrative, dict):
        raise ValueError(f"impact payload missing cluster_narrative object: {path}")
    for field in REQUIRED_NARRATIVE_FIELDS:
        _require_non_empty_string(narrative, field, path)

    approach = payload.get("recommended_approach")
    if not isinstance(approach, dict):
        raise ValueError(f"impact payload missing recommended_approach object: {path}")
    for field in REQUIRED_APPROACH_FIELDS:
        if field not in approach:
            raise ValueError(f"impact payload missing recommended_approach.{field}: {path}")
    strategy = _require_non_empty_string(approach, "strategy", path)
    if strategy not in VALID_STRATEGIES:
        raise ValueError(f"impact payload has invalid strategy: {path}")
    _require_non_empty_string(approach, "description", path)
    fix_order = _require_string_list(approach, "fix_order", path)
    validation_steps = _require_string_list(approach, "validation_steps", path)
    fix_blast_radius_files = approach.get("fix_blast_radius_files")
    if not isinstance(fix_blast_radius_files, int) or fix_blast_radius_files < 0:
        raise ValueError(f"impact payload has invalid fix_blast_radius_files: {path}")
    _require_non_empty_string(approach, "risk_assessment", path)

    finding_ids = {
        str(finding.get("finding_id", "")).strip()
        for finding in findings
    }
    if any(finding_id not in finding_ids for finding_id in fix_order):
        raise ValueError(f"impact payload fix_order references unknown finding ids: {path}")
    if not validation_steps:
        raise ValueError(f"impact payload missing validation_steps entries: {path}")

    return payload


def _write_sentinel(path: str, lines: int) -> None:
    sentinel_path = f"{path}.done"
    payload = {
        "lines": lines,
        "auto_recovered": False,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with open(sentinel_path, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def _expected_merged_findings(parts_dir: str, completed_clusters: list[str]) -> int:
    total = 0
    for cluster_id in completed_clusters:
        part_path = os.path.join(parts_dir, f"{cluster_id}.json")
        payload = _validate_cluster_payload(_load_cluster_payload(part_path), cluster_id, part_path)
        total += len(payload["findings"])
    return total


def _merge_is_stale(
    audit_dir: str,
    deep_dir: str,
    parts_dir: str,
    expected_clusters: list[str],
    completed_clusters: list[str],
) -> bool:
    final_path = os.path.join(deep_dir, FINAL_FILENAME)
    manifest_path = os.path.join(deep_dir, MANIFEST_FILENAME)
    if not os.path.isfile(final_path) or not os.path.isfile(manifest_path):
        return True

    try:
        manifest = _load_json(manifest_path)
    except (OSError, json.JSONDecodeError, ValueError):
        return True

    source_files = [
        os.path.relpath(os.path.join(parts_dir, f"{cluster_id}.json"), audit_dir)
        for cluster_id in completed_clusters
    ]
    expected_findings = _expected_merged_findings(parts_dir, completed_clusters)
    if manifest.get("expected_clusters") != expected_clusters:
        return True
    if manifest.get("completed_clusters") != completed_clusters:
        return True
    if manifest.get("source_files") != source_files:
        return True
    if manifest.get("merged_findings") != expected_findings:
        return True
    if manifest.get("final_output") != os.path.relpath(final_path, audit_dir):
        return True

    final_mtime = os.path.getmtime(final_path)
    manifest_mtime = os.path.getmtime(manifest_path)
    if manifest_mtime < final_mtime:
        return True
    for cluster_id in completed_clusters:
        part_path = os.path.join(parts_dir, f"{cluster_id}.json")
        if os.path.getmtime(part_path) > final_mtime:
            return True
    return False


def impact_output_status(project_dir: str) -> dict[str, Any]:
    audit_dir = os.path.join(project_dir, "docs", "audit")
    deep_dir = os.path.join(audit_dir, "deep")
    clusters_path = os.path.join(deep_dir, "clusters.json")
    expected_clusters: list[str] = []
    if os.path.isfile(clusters_path):
        clusters = _load_json(clusters_path)
        expected_clusters = [
            str(cluster.get("id", ""))
            for cluster in clusters.get("clusters", [])
            if str(cluster.get("id", "")).strip()
        ]

    parts_dir = os.path.join(deep_dir, PARTS_DIRNAME)
    completed_clusters: list[str] = []
    invalid_parts: list[str] = []
    if os.path.isdir(parts_dir):
        for cluster_id in expected_clusters:
            part_path = os.path.join(parts_dir, f"{cluster_id}.json")
            if not os.path.isfile(part_path):
                continue
            try:
                payload = _load_cluster_payload(part_path)
            except (ValueError, json.JSONDecodeError):
                invalid_parts.append(cluster_id)
                continue
            try:
                _validate_cluster_payload(payload, cluster_id, part_path)
            except ValueError:
                invalid_parts.append(cluster_id)
                continue
            completed_clusters.append(cluster_id)

    missing_clusters = [
        cluster_id for cluster_id in expected_clusters
        if cluster_id not in completed_clusters and cluster_id not in invalid_parts
    ]
    audit_complete = bool(expected_clusters) and not missing_clusters and not invalid_parts
    merge_needed = audit_complete and _merge_is_stale(
        audit_dir,
        deep_dir,
        parts_dir,
        expected_clusters,
        completed_clusters,
    )
    return {
        "parts_dir": parts_dir,
        "expected_clusters": expected_clusters,
        "completed_clusters": completed_clusters,
        "missing_clusters": missing_clusters,
        "invalid_parts": invalid_parts,
        "complete": audit_complete,
        "merge_needed": merge_needed,
    }


def merge_impact_analysis_outputs(project_dir: str) -> dict[str, Any]:
    status = impact_output_status(project_dir)
    if not status["complete"]:
        raise ValueError("impact analysis parts are incomplete")

    audit_dir = os.path.join(project_dir, "docs", "audit")
    deep_dir = os.path.join(audit_dir, "deep")
    parts_dir = status["parts_dir"]
    merged_rows: list[dict[str, Any]] = []
    source_files: list[str] = []

    for cluster_id in status["completed_clusters"]:
        part_path = os.path.join(parts_dir, f"{cluster_id}.json")
        payload = _validate_cluster_payload(_load_cluster_payload(part_path), cluster_id, part_path)
        source_files.append(os.path.relpath(part_path, audit_dir))
        cluster_id_value = str(payload.get("cluster_id", cluster_id))
        cluster_label = str(payload.get("cluster_label", ""))
        analyzed_at = payload.get("analyzed_at")
        cluster_narrative = payload.get("cluster_narrative")
        recommended_approach = payload.get("recommended_approach")
        for finding in payload.get("findings", []):
            row = dict(finding)
            row["cluster_id"] = cluster_id_value
            row["cluster_label"] = cluster_label
            row["analyzed_at"] = analyzed_at
            row["cluster_narrative"] = cluster_narrative
            row["recommended_approach"] = recommended_approach
            merged_rows.append(row)

    final_path = os.path.join(deep_dir, FINAL_FILENAME)
    with open(final_path, "w") as fh:
        for row in merged_rows:
            fh.write(json.dumps(row) + "\n")
    _write_sentinel(final_path, len(merged_rows))

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "expected_clusters": status["expected_clusters"],
        "completed_clusters": status["completed_clusters"],
        "source_files": source_files,
        "merged_findings": len(merged_rows),
        "final_output": os.path.relpath(final_path, audit_dir),
    }
    manifest_path = os.path.join(deep_dir, MANIFEST_FILENAME)
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    return manifest


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: merge_impact_analysis.py <project_dir>")
        return 1
    project_dir = os.path.abspath(argv[1])
    status = impact_output_status(project_dir)
    if not status["complete"]:
        print("IMPACT_PARTS_INCOMPLETE")
        print(f"completed={len(status['completed_clusters'])} missing={len(status['missing_clusters'])} invalid={len(status['invalid_parts'])}")
        return 1
    manifest = merge_impact_analysis_outputs(project_dir)
    print(f"IMPACT_MERGED: {manifest['merged_findings']} findings from {len(manifest['completed_clusters'])} clusters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
