from __future__ import annotations

import json
import os
import sys
import tempfile


SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from bundle_renderer import render_bundle
from compute_audit_stats import write_stats
from report_contract import generate_phase_docs, generate_report_manifest, validate_publication_contract


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def _write_jsonl(path: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def test_rendered_bundle_is_validator_clean() -> None:
    with tempfile.TemporaryDirectory() as audit_dir:
        _write_json(
            os.path.join(audit_dir, "data", "inventory.json"),
            {
                "root": "fixture",
                "stack": "typescript",
                "framework": "react",
                "total_files": 2,
                "total_loc": 200,
                "layers": {"components": {"files": ["src/App.tsx"], "loc": 150}, "utils": {"files": ["src/util.ts"], "loc": 50}},
                "files": [
                    {"path": "src/App.tsx", "loc": 150, "layer": "components", "tag": "SOURCE"},
                    {"path": "src/util.ts", "loc": 50, "layer": "utils", "tag": "SOURCE"},
                ],
            },
        )
        _write_jsonl(
            os.path.join(audit_dir, "data", "findings.jsonl"),
            [
                {
                    "id": "SEC-001",
                    "rule": "R05",
                    "severity": "CRITICAL",
                    "category": "security",
                    "file": "src/App.tsx",
                    "line": 12,
                    "layer": "components",
                    "phase": 1,
                    "description": "Unsafe auth bypass",
                    "explanation": "Unsafe auth bypass exists.",
                    "current_code": "auth = false",
                    "target_code": "auth = true",
                    "search_pattern": "auth = false",
                    "effort": "medium",
                    "cross_cutting": True,
                    "cross_cutting_group": "R05 auth bypass",
                    "cluster_id": "CLU-001",
                },
                {
                    "id": "DRY-001",
                    "rule": "R01",
                    "severity": "HIGH",
                    "category": "ssot-dry",
                    "file": "src/util.ts",
                    "line": 9,
                    "layer": "utils",
                    "phase": 3,
                    "description": "Shared constant duplicated",
                    "explanation": "Shared constant duplicated.",
                    "current_code": "const URL = 'x'",
                    "target_code": "export const URL = 'x'",
                    "search_pattern": "const URL",
                    "effort": "low",
                    "cluster_id": "CLU-002",
                },
            ],
        )
        _write_json(
            os.path.join(audit_dir, "data", "quality-gate.json"),
            {
                "overall": "FAIL",
                "tiers": {
                    "security": {
                        "status": "FAIL",
                        "details": "1 CRITICAL vulnerabilities",
                        "blocker_finding_ids": ["SEC-001"],
                    }
                },
                "blocker_explanation": {"security": ["SEC-001"]},
            },
        )
        _write_json(
            os.path.join(audit_dir, "deep", "clusters.json"),
            {
                "clusters": [
                    {"id": "CLU-001", "type": "cross_cutting", "name": "Auth bypass", "finding_count": 1, "max_severity": "CRITICAL", "rules": ["R05"], "root_pattern": "auth bypass", "files": ["src/App.tsx"], "finding_ids": ["SEC-001"]},
                    {"id": "CLU-002", "type": "file", "name": "Shared constant", "finding_count": 1, "max_severity": "HIGH", "rules": ["R01"], "root_pattern": "shared constant", "files": ["src/util.ts"], "finding_ids": ["DRY-001"]},
                ]
            },
        )
        _write_jsonl(
            os.path.join(audit_dir, "deep", "impact-analysis.jsonl"),
            [
                {
                    "cluster_id": "CLU-001",
                    "cluster_label": "Auth bypass",
                    "finding_id": "SEC-001",
                    "file": "src/App.tsx",
                    "line": 12,
                    "effective_severity": "CRITICAL-x3",
                    "cluster_narrative": {
                        "root_cause": "missing auth abstraction",
                        "systemic_pattern": "auth bypass",
                        "business_impact": "users can skip auth",
                        "why_it_exists": "unsafe shortcut",
                    },
                    "recommended_approach": {
                        "strategy": "refactor_pattern",
                        "description": "centralize auth",
                        "fix_order": ["SEC-001"],
                        "fix_blast_radius_files": 1,
                        "risk_assessment": "medium",
                        "validation_steps": ["run auth tests"],
                    },
                }
            ],
        )
        _write_json(
            os.path.join(audit_dir, "deep", "dependency-graph.json"),
            {"nodes": [], "edges": []},
        )
        _write_json(os.path.join(audit_dir, "data", "phase-dag.json"), {"nodes": [], "edges": []})
        _write_json(os.path.join(audit_dir, "data", "tasks", "phase-1-tasks.json"), {"phase": 1, "phase_name": "Security", "prerequisites": [], "status": "not_started", "total_tasks": 1, "completed": 0, "tasks": [{"id": "SEC-001"}], "verification": {"command": "echo ok", "expected": "ok", "description": "ok"}})
        _write_json(os.path.join(audit_dir, "data", "tasks", "phase-3-tasks.json"), {"phase": 3, "phase_name": "SSOT/DRY", "prerequisites": [], "status": "not_started", "total_tasks": 1, "completed": 0, "tasks": [{"id": "DRY-001"}], "verification": {"command": "echo ok", "expected": "ok", "description": "ok"}})

        write_stats(audit_dir)
        generate_phase_docs(audit_dir)
        generate_report_manifest(audit_dir)
        render_bundle(audit_dir, "byakugan", check=False)

        result = validate_publication_contract(audit_dir, stage="byakugan")
        assert result["ok"] is True
