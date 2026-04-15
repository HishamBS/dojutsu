"""Tests for deterministic phase task generation."""
from __future__ import annotations

import json
import importlib.util
import os
import sys
import tempfile

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
MODULE_PATH = os.path.join(SCRIPTS_DIR, "create-phase-tasks.py")
spec = importlib.util.spec_from_file_location("rinnegan_create_phase_tasks", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.path.insert(0, SCRIPTS_DIR)
spec.loader.exec_module(module)
generate_phase_tasks = module.generate_phase_tasks


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)


def _write_jsonl(path: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


class TestCreatePhaseTasks:
    def test_generates_all_phase_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            _write_json(
                os.path.join(audit_dir, "data", "inventory.json"),
                {"stack": "python", "framework": "fastapi"},
            )
            _write_jsonl(
                os.path.join(audit_dir, "data", "findings.jsonl"),
                [
                    {
                        "id": "SEC-001",
                        "rule": "R05",
                        "severity": "HIGH",
                        "file": "app/security.py",
                        "line": 12,
                        "current_code": "verify=False",
                        "target_code": "verify=True",
                        "target_import": "from app.http import secure_client",
                        "search_pattern": "verify=False",
                        "explanation": "TLS validation disabled",
                        "effort": "low",
                        "phase": 1,
                        "fix_plan": None,
                    },
                    {
                        "id": "DRY-001",
                        "rule": "R01",
                        "severity": "MEDIUM",
                        "file": "app/constants.py",
                        "line": 4,
                        "current_code": "TIMEOUT = 200",
                        "target_code": None,
                        "target_import": None,
                        "search_pattern": "TIMEOUT = 200",
                        "explanation": "Duplicate constant",
                        "effort": "medium",
                        "phase": 3,
                        "fix_plan": [{"step": 1, "action": "edit", "file": "app/constants.py"}],
                    },
                ],
            )

            written = generate_phase_tasks(audit_dir, project_dir)

            assert len(written) == 11
            phase1_path = os.path.join(audit_dir, "data", "tasks", "phase-1-tasks.json")
            with open(phase1_path) as fh:
                phase1 = json.load(fh)
            assert phase1["total_tasks"] == 1
            assert phase1["tasks"][0]["imports_needed"] == ["from app.http import secure_client"]
            assert phase1["verification"]["expected"] == "0"

            phase3_path = os.path.join(audit_dir, "data", "tasks", "phase-3-tasks.json")
            with open(phase3_path) as fh:
                phase3 = json.load(fh)
            assert phase3["prerequisites"] == ["phase-1", "phase-2"]
            assert phase3["tasks"][0]["fix_plan"][0]["action"] == "edit"

    def test_marks_empty_phases_clear(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            _write_json(
                os.path.join(audit_dir, "data", "inventory.json"),
                {"stack": "typescript", "framework": "react"},
            )
            _write_jsonl(os.path.join(audit_dir, "data", "findings.jsonl"), [])

            generate_phase_tasks(audit_dir, project_dir)

            phase0_path = os.path.join(audit_dir, "data", "tasks", "phase-0-tasks.json")
            with open(phase0_path) as fh:
                phase0 = json.load(fh)
            assert phase0["status"] == "clear"
            assert phase0["tasks"] == []
