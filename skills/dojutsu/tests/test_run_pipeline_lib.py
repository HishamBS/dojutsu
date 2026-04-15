"""Tests for dojutsu stage detection."""
from __future__ import annotations

import json
import importlib.util
import os
import sys
import tempfile

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
MODULE_PATH = os.path.join(SCRIPTS_DIR, "run_pipeline_lib.py")
sys.path.insert(0, SCRIPTS_DIR)
spec = importlib.util.spec_from_file_location("dojutsu_run_pipeline_lib", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
default_state = module.default_state
detect_stage = module.detect_stage


def _touch(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("ok\n")


def _write_bundle_verdict(audit_dir: str, stage: str, ok: bool = True) -> None:
    path = os.path.join(audit_dir, "data", "bundle-verdict.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump({"stage": stage, "ok": ok, "errors": [], "source_hashes": {}}, fh)


class TestDetectStage:
    def test_rinnegan_stays_active_without_bundle_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = os.path.join(tmp, "docs", "audit")
            _touch(os.path.join(audit_dir, "master-audit.md"))
            state = default_state()
            assert detect_stage(tmp, state) == "RINNEGAN_ACTIVE"

    def test_byakugan_not_complete_without_executive_brief(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = os.path.join(tmp, "docs", "audit")
            deep_dir = os.path.join(audit_dir, "deep")
            _touch(os.path.join(audit_dir, "master-audit.md"))
            _write_bundle_verdict(audit_dir, "rinnegan")
            for filename in (
                "dependency-graph.json",
                "clusters.json",
                "impact-analysis.jsonl",
                "narrative.md",
                "scorecard.md",
                "deployment-plan.md",
            ):
                _touch(os.path.join(deep_dir, filename))
            state = default_state()
            assert detect_stage(tmp, state) == "BYAKUGAN_ACTIVE"

    def test_moves_to_rasengan_only_after_full_byakugan_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = os.path.join(tmp, "docs", "audit")
            deep_dir = os.path.join(audit_dir, "deep")
            _touch(os.path.join(audit_dir, "master-audit.md"))
            _write_bundle_verdict(audit_dir, "byakugan")
            for filename in (
                "dependency-graph.json",
                "clusters.json",
                "impact-analysis.jsonl",
                "narrative.md",
                "scorecard.md",
                "deployment-plan.md",
                "executive-brief.md",
            ):
                _touch(os.path.join(deep_dir, filename))
            state = default_state()
            assert detect_stage(tmp, state) == "RASENGAN_PHASE_0"
