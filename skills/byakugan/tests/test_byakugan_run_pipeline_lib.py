"""Tests for byakugan stage detection."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time


SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
MODULE_PATH = os.path.join(SCRIPTS_DIR, "run_pipeline_lib.py")
sys.path.insert(0, SCRIPTS_DIR)

spec = importlib.util.spec_from_file_location("byakugan_run_pipeline_lib", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
get_state = module.get_state


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)


class TestGetState:
    def test_existing_output_is_remerged_when_checkpoint_parts_are_newer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = tmp
            audit_dir = os.path.join(project_dir, "docs", "audit")
            deep_dir = os.path.join(audit_dir, "deep")
            data_dir = os.path.join(audit_dir, "data")
            os.makedirs(data_dir, exist_ok=True)
            with open(os.path.join(data_dir, "findings.jsonl"), "w") as fh:
                fh.write("{}\n")

            _write_json(
                os.path.join(deep_dir, "dependency-graph.json"),
                {"nodes": [], "edges": []},
            )
            _write_json(
                os.path.join(deep_dir, "clusters.json"),
                {"clusters": [{"id": "CLU-001"}]},
            )
            part_path = os.path.join(deep_dir, "impact-analysis-parts", "CLU-001.json")
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

            with open(os.path.join(deep_dir, "impact-analysis.jsonl"), "w") as fh:
                fh.write('{"cluster_id":"CLU-001"}\n')
            _write_json(
                os.path.join(deep_dir, "impact-analysis-manifest.json"),
                {
                    "expected_clusters": ["CLU-001"],
                    "completed_clusters": ["CLU-001"],
                    "source_files": ["deep/impact-analysis-parts/CLU-001.json"],
                    "merged_findings": 1,
                    "final_output": "deep/impact-analysis.jsonl",
                },
            )

            time.sleep(0.01)
            os.utime(part_path, None)

            assert get_state(project_dir) == "NEEDS_IMPACT_MERGE"
