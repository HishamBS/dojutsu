from __future__ import annotations

import json
import os
import sys
import tempfile


SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from finding_families import collapse_finding_families


def _write_findings(audit_dir: str, rows: list[dict]) -> None:
    path = os.path.join(audit_dir, "data", "findings.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def _load_findings(audit_dir: str) -> list[dict]:
    with open(os.path.join(audit_dir, "data", "findings.jsonl")) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_repeated_r01_findings_collapse_to_root_cause_family() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        audit_dir = tmp
        _write_findings(
            audit_dir,
            [
                {
                    "id": "DRY-001",
                    "rule": "R01",
                    "severity": "CRITICAL",
                    "file": "src/a.ts",
                    "line": 10,
                    "description": "DEFAULT_BASE_URL duplicated",
                    "search_pattern": "DEFAULT_BASE_URL",
                },
                {
                    "id": "DRY-002",
                    "rule": "R01",
                    "severity": "CRITICAL",
                    "file": "src/b.ts",
                    "line": 10,
                    "description": "DEFAULT_BASE_URL duplicated",
                    "search_pattern": "DEFAULT_BASE_URL",
                },
            ],
        )

        result = collapse_finding_families(audit_dir)
        rows = _load_findings(audit_dir)

        assert result["families_created"] == 1
        root = next(row for row in rows if row.get("is_root_cause") is True)
        subordinate = next(row for row in rows if row.get("is_root_cause") is False)
        assert root["severity"] == "CRITICAL"
        assert subordinate["severity"] == "HIGH"
        assert subordinate["parent_finding_id"] == root["id"]

