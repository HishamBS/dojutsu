"""Tests for deterministic cluster publication."""
from __future__ import annotations

import json
import os
import sys
import tempfile

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from cluster_findings import annotate_findings_with_cluster_ids, cluster_cross_cutting


def _write_findings(project_dir: str, findings: list[dict]) -> str:
    findings_path = os.path.join(project_dir, "docs", "audit", "data", "findings.jsonl")
    os.makedirs(os.path.dirname(findings_path), exist_ok=True)
    with open(findings_path, "w") as fh:
        for finding in findings:
            fh.write(json.dumps(finding) + "\n")
    return findings_path


class TestClusterCrossCutting:
    def test_uses_cross_cutting_group_field(self) -> None:
        findings = [
            {
                "id": "DRY-001",
                "rule": "R01",
                "description": "Shared default duplicated",
                "file": "src/a.ts",
                "cross_cutting_group": "3.1 Shared defaults",
            },
            {
                "id": "DRY-002",
                "rule": "R01",
                "description": "Shared default duplicated",
                "file": "src/b.ts",
                "cross_cutting_group": "3.1 Shared defaults",
            },
        ]
        clusters = cluster_cross_cutting(findings)
        assert len(clusters) == 1
        assert clusters[0]["source"] == "cross_cutting_group"


class TestClusterAnnotation:
    def test_writes_cluster_id_back_to_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            findings = [
                {"id": "DRY-001", "file": "src/a.ts"},
                {"id": "DRY-002", "file": "src/b.ts"},
            ]
            findings_path = _write_findings(tmp, findings)
            clusters = [
                {"id": "CLU-001", "finding_ids": ["DRY-001", "DRY-002"]},
            ]

            updated = annotate_findings_with_cluster_ids(tmp, clusters)

            assert updated == 2
            with open(findings_path) as fh:
                rows = [json.loads(line) for line in fh if line.strip()]
            assert {row["cluster_id"] for row in rows} == {"CLU-001"}
