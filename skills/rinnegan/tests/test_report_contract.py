"""Tests for deterministic audit publication contract helpers."""
from __future__ import annotations

import json
import os
import sys
import tempfile

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from compute_audit_stats import write_stats
from bundle_renderer import render_bundle
from report_contract import (
    canonical_layer_doc_relpath,
    canonical_phase_doc_relpath,
    generate_phase_docs,
    generate_report_manifest,
    validate_publication_contract,
)


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)


def _write_jsonl(path: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def _make_finding(finding_id: str, phase: int, layer: str, severity: str, category: str, file: str) -> dict:
    return {
        "id": finding_id,
        "rule": "R07" if phase == 2 else "R01",
        "severity": severity,
        "category": category,
        "file": file,
        "line": 10,
        "snippet": "const value = thing;",
        "current_code": "const value = thing;",
        "description": "Test finding for publication contract",
        "explanation": "This deterministic fixture exists to validate the audit publication contract.",
        "target_code": "const value = validatedThing;",
        "search_pattern": "const value = thing;",
        "phase": phase,
        "effort": "low",
        "confidence": "high",
        "confidence_reason": "HIGH: deterministic fixture",
        "layer": layer,
        "scanner": "fixture-scanner",
    }


def _write_task_file(audit_dir: str, phase: int, phase_name: str, tasks: list[dict]) -> None:
    _write_json(
        os.path.join(audit_dir, "data", "tasks", f"phase-{phase}-tasks.json"),
        {
            "phase": phase,
            "phase_name": phase_name,
            "prerequisites": [],
            "status": "not_started",
            "total_tasks": len(tasks),
            "completed": 0,
            "tasks": tasks,
            "verification": {
                "command": "echo ok",
                "expected": "ok",
                "description": "Fixture verification",
            },
        },
    )


def _build_fixture(tmp: str) -> str:
    audit_dir = tmp
    findings = [
        _make_finding("TYP-001", 2, "services", "HIGH", "typing", "src/service.py"),
        _make_finding("DRY-001", 3, "utils", "MEDIUM", "ssot-dry", "src/utils.py"),
    ]
    _write_jsonl(os.path.join(audit_dir, "data", "findings.jsonl"), findings)
    _write_json(os.path.join(audit_dir, "data", "inventory.json"), {
        "root": "fixture",
        "stack": "python",
        "framework": "fastapi",
        "total_files": 3,
        "total_loc": 120,
        "layers": {
            "services": {"files": ["src/service.py", "src/api.py"], "loc": 90},
            "utils": {"files": ["src/utils.py"], "loc": 30},
        },
        "files": [
            {"path": "src/service.py", "loc": 50, "layer": "services"},
            {"path": "src/api.py", "loc": 40, "layer": "services"},
            {"path": "src/utils.py", "loc": 30, "layer": "utils"},
        ],
    })
    _write_json(os.path.join(audit_dir, "data", "phase-dag.json"), {"nodes": [], "edges": []})
    _write_task_file(audit_dir, 2, "Typing (R07)", [findings[0]])
    _write_task_file(audit_dir, 3, "SSOT/DRY (R01)", [findings[1]])
    write_stats(audit_dir)
    generate_phase_docs(audit_dir)
    generate_report_manifest(audit_dir)
    render_bundle(audit_dir, "rinnegan", check=False)
    return audit_dir


class TestPhaseDocGeneration:
    def test_generate_phase_docs_uses_canonical_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_fixture(tmp)
            assert os.path.isfile(os.path.join(audit_dir, canonical_phase_doc_relpath(3)))


class TestPublicationValidation:
    def test_valid_fixture_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_fixture(tmp)
            result = validate_publication_contract(audit_dir, stage="rinnegan")
            assert result["ok"] is True
            assert result["errors"] == []

    def test_broken_layer_link_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_fixture(tmp)
            with open(os.path.join(audit_dir, "master-audit.md"), "a") as fh:
                fh.write("\n[Broken](layers/services-audit.md)\n")
            result = validate_publication_contract(audit_dir, stage="rinnegan")
            assert result["ok"] is False
            assert any("broken link" in error for error in result["errors"])

    def test_null_fix_contract_violation_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_fixture(tmp)
            findings_path = os.path.join(audit_dir, "data", "findings.jsonl")
            with open(findings_path) as fh:
                rows = [json.loads(line) for line in fh if line.strip()]
            rows[0]["target_code"] = None
            rows[0]["fix_plan"] = None
            _write_jsonl(findings_path, rows)
            write_stats(audit_dir)
            result = validate_publication_contract(audit_dir, stage="rinnegan")
            assert result["ok"] is False
            assert any("null-fix contract violated" in error for error in result["errors"])
