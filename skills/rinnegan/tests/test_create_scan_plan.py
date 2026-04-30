"""Tests for dynamic batch sizing via DojutsuConfig.max_batch_for().

Validates that scanner batch sizes adapt to model context window and file size,
ensuring large files produce smaller batches and small files hit the batch cap.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import textwrap

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from dojutsu_config import DojutsuConfig

# Load the hyphenated script as an importable module
_spec = importlib.util.spec_from_file_location(
    "create_scan_plan",
    os.path.join(os.path.abspath(SCRIPTS_DIR), "create-scan-plan.py"),
)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
sys.modules["create_scan_plan"] = _module
_spec.loader.exec_module(_module)  # type: ignore[union-attr]

# ---------------------------------------------------------------------------
# Shared TOML fixtures
# ---------------------------------------------------------------------------

_CHEAP_TOML = textwrap.dedent("""\
    [pipeline]
    batch_size = 25

    [models.tiers.cheap]
    claude = "claude-haiku-4-5"
    context_window = 200000

    [models.assignments]
    scanner = "cheap"
""")

_MID_TOML = textwrap.dedent("""\
    [pipeline]
    batch_size = 25

    [models.tiers.mid]
    claude = "claude-sonnet-4-6"
    context_window = 1000000

    [models.assignments]
    scanner = "mid"
""")


def _write_config(tmp_path: str, content: str) -> str:
    """Write a TOML config and return its path."""
    config_file = tmp_path / "dojutsu.toml"
    config_file.write_text(content)
    return str(config_file)


# ---------------------------------------------------------------------------
# Dynamic batch sizing tests
# ---------------------------------------------------------------------------


class TestDynamicBatchSizing:
    """DojutsuConfig.max_batch_for adjusts batches based on context window."""

    def test_large_files_get_smaller_batches(self, tmp_path: str) -> None:
        """Cheap tier (200k window) with avg_loc=2000 produces < 15 files/batch.

        Calculation:
            usable  = int(200_000 * 0.60) - 30_000 = 90_000
            per_file = 2000 * 5 + 500 = 10_500
            max_files = 90_000 // 10_500 = 8
            result = max(5, min(8, 25)) = 8
        """
        path = _write_config(tmp_path, _CHEAP_TOML)
        cfg = DojutsuConfig(config_path=path)
        result = cfg.max_batch_for("scanner", avg_loc=2000)
        assert result < 15, f"Expected < 15 for large files on cheap tier, got {result}"
        assert result == 8

    def test_small_files_use_full_batch(self, tmp_path: str) -> None:
        """Mid tier (1M window) with avg_loc=200 hits the batch_size cap.

        Calculation:
            usable  = int(1_000_000 * 0.60) - 30_000 = 570_000
            per_file = 200 * 5 + 500 = 1_500
            max_files = 570_000 // 1_500 = 380
            result = max(5, min(380, 25)) = 25  (capped by batch_size)
        """
        path = _write_config(tmp_path, _MID_TOML)
        cfg = DojutsuConfig(config_path=path)
        result = cfg.max_batch_for("scanner", avg_loc=200)
        assert result == cfg.batch_size, (
            f"Expected batch_size cap ({cfg.batch_size}), got {result}"
        )


def test_build_plan_excludes_nominal_files_from_llm_batches(tmp_path):
    """Refactor: build_plan is now an importable callable. Nominal files are
    in inventory but not assigned to LLM scanner batches."""
    from create_scan_plan import build_plan
    audit_dir = tmp_path / "audit"
    (audit_dir / "data").mkdir(parents=True)
    inventory = {
        "files": [
            {"path": "src/tiny.ts", "loc": 1, "layer": "misc", "tag": "SOURCE", "nominal": True, "is_meta_file": False},
            {"path": "src/real.ts", "loc": 200, "layer": "misc", "tag": "SOURCE", "nominal": False, "is_meta_file": False},
        ],
        "total_loc": 201,
    }
    (audit_dir / "data" / "inventory.json").write_text(json.dumps(inventory))
    plan = build_plan(str(audit_dir))
    batched = {f for batch in plan["batches"] for f in batch["files"]}
    assert "src/real.ts" in batched
    assert "src/tiny.ts" not in batched


def test_build_plan_excludes_meta_files_from_llm_batches(tmp_path):
    from create_scan_plan import build_plan
    audit_dir = tmp_path / "audit"
    (audit_dir / "data").mkdir(parents=True)
    inventory = {
        "files": [
            {"path": "scripts/ci/enforce-rules.ts", "loc": 200, "layer": "config", "tag": "SOURCE", "nominal": False, "is_meta_file": True},
            {"path": "src/real.ts", "loc": 200, "layer": "misc", "tag": "SOURCE", "nominal": False, "is_meta_file": False},
        ],
        "total_loc": 400,
    }
    (audit_dir / "data" / "inventory.json").write_text(json.dumps(inventory))
    plan = build_plan(str(audit_dir))
    batched = {f for batch in plan["batches"] for f in batch["files"]}
    assert "src/real.ts" in batched
    assert "scripts/ci/enforce-rules.ts" not in batched


def test_build_plan_assigns_correct_layer_after_filtering_nominal_files(tmp_path):
    """Regression: when nominal/meta files appear in inventory before a batch,
    the batch's layer must reflect the actual files in the batch, not the
    pre-filter inventory index."""
    import json
    from create_scan_plan import build_plan
    audit_dir = tmp_path / "audit"
    (audit_dir / "data").mkdir(parents=True)
    inventory = {
        # First entry is nominal — would be skipped from LLM batches.
        # If layer is read from inv["files"][0], the batch wrongly labels
        # itself with the nominal file's layer ("config" here) instead of
        # the actual batch's layer ("services").
        "files": [
            {"path": "src/tiny-config.ts", "loc": 1, "layer": "config", "tag": "SOURCE", "nominal": True, "is_meta_file": False},
            {"path": "src/real-service.ts", "loc": 200, "layer": "services", "tag": "SOURCE", "nominal": False, "is_meta_file": False},
        ],
        "total_loc": 201,
    }
    (audit_dir / "data" / "inventory.json").write_text(json.dumps(inventory))
    plan = build_plan(str(audit_dir))
    assert len(plan["batches"]) == 1
    assert plan["batches"][0]["files"] == ["src/real-service.ts"]
    # The bug: layer would be "config" (from inv["files"][0]) instead of "services"
    assert plan["batches"][0]["layer"] == "services"
