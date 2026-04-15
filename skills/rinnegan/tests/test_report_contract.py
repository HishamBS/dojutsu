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


def _write_master_audit(audit_dir: str) -> None:
    lines = [
        "# Fixture Codebase Audit",
        "",
        "> **Date:** 2026-04-15 | **Stack:** python (fastapi)",
        "> **Files:** 3 | **LOC:** 120 | **Findings:** 2",
        "> **Density:** 16.7 findings/KLOC | **Readiness:** 90.0%",
        "",
        "## Severity Distribution",
        "",
        "| Severity | Count | % |",
        "|----------|------:|---:|",
        "| CRITICAL | 0 | 0.0% |",
        "| HIGH | 1 | 50.0% |",
        "| MEDIUM | 1 | 50.0% |",
        "| LOW | 0 | 0.0% |",
        "| REVIEW | 0 | 0.0% |",
        "",
        "## Layer Audit Index",
        "",
        "| Layer | Files | LOC | Findings | Density | Audit Doc |",
        "|-------|------:|----:|---------:|--------:|-----------|",
        f"| services | 2 | 90 | 1 | 11.1 | [services.md]({canonical_layer_doc_relpath('services')}) |",
        f"| utils | 1 | 30 | 1 | 33.3 | [utils.md]({canonical_layer_doc_relpath('utils')}) |",
        "",
        "## Remediation Phases",
        "",
        "| Phase | Name | Findings | Status | Phase Doc |",
        "|-------|------|----------|--------|-----------|",
    ]
    phase_counts = {2: 1, 3: 1}
    phase_names = {
        0: "Foundation", 1: "Security", 2: "Typing", 3: "SSOT/DRY", 4: "Architecture",
        5: "Clean Code", 6: "Performance", 7: "Data Integrity", 8: "Refactoring",
        9: "Verification", 10: "Documentation",
    }
    for phase_id in range(11):
        lines.append(
            f"| {phase_id} | {phase_names[phase_id]} | {phase_counts.get(phase_id, 0)} | "
            f"NOT STARTED | [phase-{phase_id}]({canonical_phase_doc_relpath(phase_id)}) |"
        )
    lines.extend([
        "",
        "## Links",
        "",
        "[Cross Cutting](cross-cutting.md)",
    ])
    with open(os.path.join(audit_dir, "master-audit.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")


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

    os.makedirs(os.path.join(audit_dir, "layers"), exist_ok=True)
    with open(os.path.join(audit_dir, canonical_layer_doc_relpath("services")), "w") as fh:
        fh.write("# Services\n")
    with open(os.path.join(audit_dir, canonical_layer_doc_relpath("utils")), "w") as fh:
        fh.write("# Utils\n")
    with open(os.path.join(audit_dir, "cross-cutting.md"), "w") as fh:
        fh.write("# Cross-Cutting Patterns\n\nNo cross-cutting patterns detected.\n")
    with open(os.path.join(audit_dir, "progress.md"), "w") as fh:
        fh.write("# Progress\n")
    with open(os.path.join(audit_dir, "agent-instructions.md"), "w") as fh:
        fh.write("# Agent Instructions\n")
    _write_master_audit(audit_dir)
    return audit_dir


class TestPhaseDocGeneration:
    def test_generate_phase_docs_uses_canonical_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _build_fixture(tmp)
            generated = generate_phase_docs(audit_dir)
            assert canonical_phase_doc_relpath(0) in generated
            assert canonical_phase_doc_relpath(10) in generated
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
