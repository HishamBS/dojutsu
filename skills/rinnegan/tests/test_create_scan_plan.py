"""Tests for dynamic batch sizing via DojutsuConfig.max_batch_for().

Validates that scanner batch sizes adapt to model context window and file size,
ensuring large files produce smaller batches and small files hit the batch cap.
"""
from __future__ import annotations

import os
import sys
import textwrap

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from dojutsu_config import DojutsuConfig

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
