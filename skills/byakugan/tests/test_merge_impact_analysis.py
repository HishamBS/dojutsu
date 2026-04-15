"""Tests for impact analysis merge and resume helpers."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from merge_impact_analysis import impact_output_status, merge_impact_analysis_outputs


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)


class TestMergeImpactAnalysis:
    def test_status_tracks_completed_and_missing_clusters(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = tmp
            deep_dir = os.path.join(project_dir, "docs", "audit", "deep")
            _write_json(
                os.path.join(deep_dir, "clusters.json"),
                {"clusters": [{"id": "CLU-001"}, {"id": "CLU-002"}]},
            )
            _write_json(
                os.path.join(deep_dir, "impact-analysis-parts", "CLU-001.json"),
                {
                    "cluster_id": "CLU-001",
                    "cluster_label": "Shared defaults",
                    "analyzed_at": "2026-04-15T00:00:00+00:00",
                    "source_files_read": ["src/a.ts"],
                    "read_count": 1,
                    "findings": [
                        {
                            "finding_id": "DRY-001",
                            "file": "src/a.ts",
                            "line": 10,
                        }
                    ],
                    "cluster_narrative": {
                        "root_cause": "duplication",
                        "systemic_pattern": "repeated",
                        "business_impact": "shared defaults drift",
                        "why_it_exists": "missing shared module",
                    },
                    "recommended_approach": {
                        "strategy": "extract_and_replace",
                        "description": "Extract shared defaults.",
                        "fix_order": ["DRY-001"],
                        "fix_blast_radius_files": 2,
                        "risk_assessment": "Low risk with focused tests.",
                        "validation_steps": ["Run unit tests"],
                    },
                },
            )

            status = impact_output_status(project_dir)

            assert status["completed_clusters"] == ["CLU-001"]
            assert status["missing_clusters"] == ["CLU-002"]
            assert status["complete"] is False

    def test_status_marks_incomplete_cluster_payload_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = tmp
            deep_dir = os.path.join(project_dir, "docs", "audit", "deep")
            _write_json(
                os.path.join(deep_dir, "clusters.json"),
                {"clusters": [{"id": "CLU-001"}]},
            )
            _write_json(
                os.path.join(deep_dir, "impact-analysis-parts", "CLU-001.json"),
                {"cluster_id": "CLU-001"},
            )

            status = impact_output_status(project_dir)

            assert status["completed_clusters"] == []
            assert status["missing_clusters"] == []
            assert status["invalid_parts"] == ["CLU-001"]
            assert status["complete"] is False

    def test_merge_flattens_cluster_findings_to_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = tmp
            deep_dir = os.path.join(project_dir, "docs", "audit", "deep")
            _write_json(
                os.path.join(deep_dir, "clusters.json"),
                {"clusters": [{"id": "CLU-001"}]},
            )
            _write_json(
                os.path.join(deep_dir, "impact-analysis-parts", "CLU-001.json"),
                {
                    "cluster_id": "CLU-001",
                    "cluster_label": "Shared defaults",
                    "analyzed_at": "2026-04-15T00:00:00+00:00",
                    "source_files_read": ["src/a.ts", "src/b.ts"],
                    "read_count": 2,
                    "findings": [
                        {
                            "finding_id": "DRY-001",
                            "file": "src/a.ts",
                            "line": 10,
                        },
                        {
                            "finding_id": "DRY-002",
                            "file": "src/b.ts",
                            "line": 12,
                        },
                    ],
                    "cluster_narrative": {
                        "root_cause": "duplication",
                        "systemic_pattern": "repeated wrapper defaults",
                        "business_impact": "multiple generated clients drift",
                        "why_it_exists": "missing shared constants",
                    },
                    "recommended_approach": {
                        "strategy": "extract_and_replace",
                        "description": "Move shared defaults into a single module.",
                        "fix_order": ["DRY-001", "DRY-002"],
                        "fix_blast_radius_files": 3,
                        "risk_assessment": "Moderate risk if callers depend on local overrides.",
                        "validation_steps": [
                            "Run byakugan merge tests",
                            "Rebuild affected generators",
                        ],
                    },
                },
            )

            manifest = merge_impact_analysis_outputs(project_dir)

            assert manifest["merged_findings"] == 2
            output_path = os.path.join(deep_dir, "impact-analysis.jsonl")
            with open(output_path) as fh:
                rows = [json.loads(line) for line in fh if line.strip()]
            assert len(rows) == 2
            assert rows[0]["cluster_id"] == "CLU-001"
            assert rows[0]["cluster_narrative"]["root_cause"] == "duplication"

    def test_status_requires_remerge_when_checkpoint_is_newer_than_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = tmp
            deep_dir = os.path.join(project_dir, "docs", "audit", "deep")
            part_path = os.path.join(deep_dir, "impact-analysis-parts", "CLU-001.json")
            _write_json(
                os.path.join(deep_dir, "clusters.json"),
                {"clusters": [{"id": "CLU-001"}]},
            )
            _write_json(
                part_path,
                {
                    "cluster_id": "CLU-001",
                    "cluster_label": "Shared defaults",
                    "analyzed_at": "2026-04-15T00:00:00+00:00",
                    "source_files_read": ["src/a.ts"],
                    "read_count": 1,
                    "findings": [
                        {
                            "finding_id": "DRY-001",
                            "file": "src/a.ts",
                            "line": 10,
                        }
                    ],
                    "cluster_narrative": {
                        "root_cause": "duplication",
                        "systemic_pattern": "repeated",
                        "business_impact": "shared defaults drift",
                        "why_it_exists": "missing shared module",
                    },
                    "recommended_approach": {
                        "strategy": "extract_and_replace",
                        "description": "Extract shared defaults.",
                        "fix_order": ["DRY-001"],
                        "fix_blast_radius_files": 2,
                        "risk_assessment": "Low risk with focused tests.",
                        "validation_steps": ["Run unit tests"],
                    },
                },
            )

            merge_impact_analysis_outputs(project_dir)
            status = impact_output_status(project_dir)
            assert status["complete"] is True
            assert status["merge_needed"] is False

            time.sleep(0.01)
            os.utime(part_path, None)

            refreshed_status = impact_output_status(project_dir)
            assert refreshed_status["complete"] is True
            assert refreshed_status["merge_needed"] is True
