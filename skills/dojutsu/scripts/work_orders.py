#!/usr/bin/env python3
"""File-backed work-order helpers for session-resilient Dojutsu dispatches."""
from __future__ import annotations

import json
import os
from hashlib import sha256
from datetime import datetime, timezone
from typing import Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: str, payload: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def _work_order_root(audit_dir: str, stage_name: str) -> str:
    return os.path.join(audit_dir, "data", "work-orders", stage_name)


def _artifact_abspath(audit_dir: str, artifact_path: str | None) -> str | None:
    if not artifact_path:
        return None
    if os.path.isabs(artifact_path):
        return artifact_path
    return os.path.join(audit_dir, artifact_path)


def _artifact_summary(audit_dir: str, artifact_path: str | None) -> dict[str, Any] | None:
    abs_path = _artifact_abspath(audit_dir, artifact_path)
    if not abs_path or not os.path.isfile(abs_path):
        return None
    digest = sha256()
    line_count = 0
    with open(abs_path, "rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            digest.update(chunk)
            line_count += chunk.count(b"\n")
    return {
        "artifact_path": artifact_path,
        "sha256": digest.hexdigest(),
        "size_bytes": os.path.getsize(abs_path),
        "line_count": line_count,
        "updated_at": datetime.fromtimestamp(os.path.getmtime(abs_path), tz=timezone.utc).isoformat(),
    }


def _write_response_files(work_dir: str, artifact_summary: dict[str, Any] | None) -> None:
    raw_path = os.path.join(work_dir, "response.raw.txt")
    normalized_path = os.path.join(work_dir, "response.normalized.json")
    if artifact_summary is None:
        for path in (raw_path, normalized_path):
            if os.path.exists(path):
                os.remove(path)
        return
    raw_lines = [
        f"artifact_path: {artifact_summary['artifact_path']}",
        f"sha256: {artifact_summary['sha256']}",
        f"size_bytes: {artifact_summary['size_bytes']}",
        f"line_count: {artifact_summary['line_count']}",
        f"updated_at: {artifact_summary['updated_at']}",
    ]
    with open(raw_path, "w") as fh:
        fh.write("\n".join(raw_lines) + "\n")
    _write_json(normalized_path, artifact_summary)


def _upsert_work_order(audit_dir: str, stage_dir: str, unit_id: str, payload: dict[str, Any]) -> None:
    work_dir = os.path.join(stage_dir, unit_id)
    status_path = os.path.join(work_dir, "status.json")
    artifact_summary = _artifact_summary(audit_dir, payload.get("artifact_path"))
    state = payload.get("state", "pending")
    if artifact_summary is not None and state not in {"failed"}:
        state = "complete"
    created_at = _now_iso()
    request_path = os.path.join(work_dir, "request.json")
    if os.path.isfile(request_path):
        try:
            with open(request_path) as fh:
                existing_request = json.load(fh)
            created_at = str(existing_request.get("created_at", created_at))
        except (OSError, json.JSONDecodeError):
            created_at = _now_iso()
    status = {
        "updated_at": _now_iso(),
        "state": state,
        "artifact_path": payload.get("artifact_path"),
        "artifact_present": artifact_summary is not None,
    }
    request_payload = dict(payload)
    request_payload["created_at"] = created_at
    request_payload["updated_at"] = _now_iso()
    _write_json(request_path, request_payload)
    _write_json(status_path, status)
    _write_response_files(work_dir, artifact_summary)


def write_scan_work_orders(audit_dir: str, scan_plan: dict[str, Any]) -> int:
    stage_dir = _work_order_root(audit_dir, "scanner")
    count = 0
    for batch in scan_plan.get("batches", []):
        _upsert_work_order(
            audit_dir,
            stage_dir,
            f"batch-{batch['id']}",
            {
                "kind": "scanner-batch",
                "id": batch["id"],
                "layer": batch.get("layer", "mixed"),
                "files": batch.get("files", []),
                "artifact_path": batch.get("output_file"),
                "state": batch.get("status", "pending"),
            },
        )
        count += 1
    return count


def write_enrichment_work_orders(audit_dir: str, pending_layers: dict[str, int]) -> int:
    stage_dir = _work_order_root(audit_dir, "enrichment")
    count = 0
    for layer_name, finding_count in sorted(pending_layers.items()):
        _upsert_work_order(
            audit_dir,
            stage_dir,
            layer_name,
            {
                "kind": "layer-enrichment",
                "layer": layer_name,
                "finding_count": finding_count,
                "artifact_path": f"data/enriched/{layer_name}.jsonl",
                "state": "pending",
            },
        )
        count += 1
    return count


def write_impact_work_orders(audit_dir: str, clusters: list[dict[str, Any]], completed_ids: set[str]) -> int:
    stage_dir = _work_order_root(audit_dir, "impact-analysis")
    count = 0
    for cluster in clusters:
        cluster_id = str(cluster.get("id", ""))
        if not cluster_id:
            continue
        _upsert_work_order(
            audit_dir,
            stage_dir,
            cluster_id,
            {
                "kind": "impact-analysis",
                "cluster_id": cluster_id,
                "cluster_type": cluster.get("type", ""),
                "finding_count": cluster.get("finding_count", 0),
                "finding_ids": cluster.get("finding_ids", []),
                "files": cluster.get("files", []),
                "artifact_path": f"deep/impact-analysis-parts/{cluster_id}.json",
                "state": "complete" if cluster_id in completed_ids else "pending",
            },
        )
        count += 1
    return count
