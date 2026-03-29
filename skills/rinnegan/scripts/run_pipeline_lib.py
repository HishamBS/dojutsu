"""Shared validation functions for the rinnegan pipeline.

Extracted from run-pipeline.py so tests can import without side-effects.
"""
from __future__ import annotations

import json
import os
from collections import Counter
from typing import Any, TypedDict


NULL_FIX_THRESHOLD_PERCENT = 5.0

# ---------------------------------------------------------------------------
# Spec-compliant phase DAG (from output-templates.md / finding-schema.md)
# ---------------------------------------------------------------------------

SPEC_PHASE_NODES: list[dict[str, Any]] = [
    {"id": 0, "name": "Foundation", "rules": ["R14"]},
    {"id": 1, "name": "Security", "rules": ["R05"]},
    {"id": 2, "name": "Typing", "rules": ["R07"]},
    {"id": 3, "name": "SSOT/DRY", "rules": ["R01"]},
    {"id": 4, "name": "Architecture", "rules": ["R02", "R03"]},
    {"id": 5, "name": "Clean Code", "rules": ["R09", "R13"]},
    {"id": 6, "name": "Performance", "rules": ["R04"]},
    {"id": 7, "name": "Data Integrity", "rules": ["R12"]},
    {"id": 8, "name": "Refactoring", "rules": ["R10"]},
    {"id": 9, "name": "Verification", "rules": ["R16", "R08"]},
    {"id": 10, "name": "Documentation", "rules": ["R11"]},
]

SPEC_PHASE_EDGES: list[dict[str, int]] = [
    {"from": 0, "to": 1},
    {"from": 0, "to": 2},
    {"from": 1, "to": 3},
    {"from": 2, "to": 3},
    {"from": 3, "to": 4},
    {"from": 3, "to": 7},
    {"from": 4, "to": 5},
    {"from": 4, "to": 6},
    {"from": 5, "to": 8},
    {"from": 6, "to": 8},
    {"from": 7, "to": 9},
    {"from": 8, "to": 9},
    {"from": 9, "to": 10},
]

SPEC_PHASE_DAG: dict[str, Any] = {
    "nodes": SPEC_PHASE_NODES,
    "edges": SPEC_PHASE_EDGES,
}

# ---------------------------------------------------------------------------
# Rasengan config defaults (from output-templates.md section 5)
# ---------------------------------------------------------------------------

RASENGAN_CONFIG_DEFAULTS: dict[str, Any] = {
    "commit_strategy": "per-phase",
    "session_bridging": "json",
    "stale_fix_mode": "adapt",
    "mini_scan_after_phase": True,
    "sharingan_after_phase": False,
    "sharingan_after_all": True,
    "max_retries_per_phase": 2,
    "max_retries_per_task": 1,
}

# The 8 designed config fields that MUST appear in rasengan-config.json
RASENGAN_CONFIG_REQUIRED_FIELDS: frozenset[str] = frozenset(RASENGAN_CONFIG_DEFAULTS.keys())

# Project metadata fields preserved alongside config defaults
RASENGAN_CONFIG_METADATA_FIELDS: frozenset[str] = frozenset({
    "project_dir", "audit_dir", "stack", "framework",
})


class NullFixResult(TypedDict):
    triggered: bool
    null_fix_count: int
    non_review_count: int
    percent: float


def validate_null_fix_coverage(audit_dir: str) -> NullFixResult:
    """Check that non-REVIEW findings have either target_code or fix_plan.

    Returns a dict with:
      - triggered: True if the null-fix percentage exceeds the threshold
      - null_fix_count: number of non-REVIEW findings missing both fields
      - non_review_count: total non-REVIEW findings
      - percent: null_fix_count / non_review_count * 100
    """
    findings_path = os.path.join(audit_dir, "data", "findings.jsonl")
    if not os.path.isfile(findings_path):
        return NullFixResult(
            triggered=False, null_fix_count=0, non_review_count=0, percent=0.0
        )

    non_review_count = 0
    null_fix_count = 0

    with open(findings_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            finding = json.loads(line)
            severity = finding.get("severity", "")
            if severity == "REVIEW":
                continue
            non_review_count += 1

            target_code = finding.get("target_code")
            fix_plan = finding.get("fix_plan")

            has_target = target_code is not None and target_code != ""
            has_plan = fix_plan is not None and (
                isinstance(fix_plan, list) and len(fix_plan) > 0
            )

            if not has_target and not has_plan:
                null_fix_count += 1

    if non_review_count == 0:
        return NullFixResult(
            triggered=False, null_fix_count=0, non_review_count=0, percent=0.0
        )

    percent = (null_fix_count / non_review_count) * 100.0
    triggered = percent > NULL_FIX_THRESHOLD_PERCENT

    return NullFixResult(
        triggered=triggered,
        null_fix_count=null_fix_count,
        non_review_count=non_review_count,
        percent=percent,
    )


# ---------------------------------------------------------------------------
# Deterministic DAG + config generation
# ---------------------------------------------------------------------------

def _load_inventory(audit_dir: str) -> dict[str, Any]:
    """Load inventory.json, returning empty dict if missing."""
    inv_path = os.path.join(audit_dir, "data", "inventory.json")
    if not os.path.isfile(inv_path):
        return {}
    with open(inv_path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _load_config(audit_dir: str) -> dict[str, Any]:
    """Load config.json (aggregator output), returning empty dict if missing."""
    cfg_path = os.path.join(audit_dir, "data", "config.json")
    if not os.path.isfile(cfg_path):
        return {}
    with open(cfg_path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _count_findings_per_phase(audit_dir: str) -> Counter[int]:
    """Count findings per phase from findings.jsonl."""
    counts: Counter[int] = Counter()
    findings_path = os.path.join(audit_dir, "data", "findings.jsonl")
    if not os.path.isfile(findings_path):
        return counts
    with open(findings_path) as fh:
        for raw_line in fh:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            finding = json.loads(raw_line)
            phase = finding.get("phase")
            if isinstance(phase, int) and 0 <= phase <= 10:
                counts[phase] += 1
    return counts


def generate_phase_dag(audit_dir: str) -> dict[str, Any]:
    """Write spec-compliant phase-dag.json deterministically.

    Returns the DAG dict that was written.
    """
    dag = {
        "nodes": list(SPEC_PHASE_NODES),
        "edges": list(SPEC_PHASE_EDGES),
    }

    # Annotate nodes with finding counts from disk
    phase_counts = _count_findings_per_phase(audit_dir)
    for node in dag["nodes"]:
        node["finding_count"] = phase_counts.get(node["id"], 0)

    dag_path = os.path.join(audit_dir, "data", "phase-dag.json")
    os.makedirs(os.path.dirname(dag_path), exist_ok=True)
    with open(dag_path, "w") as fh:
        json.dump(dag, fh, indent=2)
        fh.write("\n")

    return dag


def generate_rasengan_config(
    audit_dir: str,
    project_dir: str,
) -> dict[str, Any]:
    """Write spec-compliant rasengan-config.json deterministically.

    Merges project metadata from inventory/config with hardcoded defaults.
    Returns the config dict that was written.
    """
    inv = _load_inventory(audit_dir)
    cfg = _load_config(audit_dir)

    config: dict[str, Any] = {
        # Project metadata (from context)
        "project_dir": project_dir,
        "audit_dir": audit_dir,
        "stack": cfg.get("stack", inv.get("stack", "unknown")),
        "framework": cfg.get("framework", inv.get("framework", "unknown")),
    }

    # Spec-required defaults (never overridden by LLM output)
    config.update(RASENGAN_CONFIG_DEFAULTS)

    config_path = os.path.join(audit_dir, "data", "rasengan-config.json")
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w") as fh:
        json.dump(config, fh, indent=2)
        fh.write("\n")

    return config


def generate_dag_and_config(
    audit_dir: str,
    project_dir: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Generate both phase-dag.json and rasengan-config.json deterministically.

    Returns (dag, config) tuple.
    """
    dag = generate_phase_dag(audit_dir)
    config = generate_rasengan_config(audit_dir, project_dir)
    return dag, config
