"""Tests for dojutsu_config -- verifies TOML config reader for pipeline settings."""
from __future__ import annotations

import os
import sys
import textwrap

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from dojutsu_config import (
    CONTEXT_UTILIZATION,
    PROMPT_OVERHEAD_TOKENS,
    TOKENS_PER_LOC,
    TOOL_OVERHEAD_PER_FILE,
    DojutsuConfig,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SAMPLE_TOML = textwrap.dedent("""\
    [pipeline]
    batch_size = 25
    max_parallel_agents = 5
    session_token_budget = 250000

    [models.tiers.cheap]
    claude = "claude-haiku-4-5"
    context_window = 200000

    [models.tiers.mid]
    claude = "claude-sonnet-4-6"
    context_window = 1000000

    [models.tiers.premium]
    claude = "claude-opus-4-6"
    context_window = 1000000

    [models.assignments]
    scanner = "cheap"
    aggregator = "cheap"
    enricher = "mid"
    master_hub_generator = "premium"
    narrator = "premium"
    fixer = "mid"
    verifier = "mid"
""")


def _write_config(tmp_path: str, content: str = _SAMPLE_TOML) -> str:
    """Write a TOML config to tmp_path and return its path."""
    config_file = tmp_path / "dojutsu.toml"
    config_file.write_text(content)
    return str(config_file)


# ---------------------------------------------------------------------------
# Pipeline scalar settings
# ---------------------------------------------------------------------------

class TestBatchSize:
    """batch_size loaded from [pipeline].batch_size."""

    def test_loads_batch_size_from_config(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.batch_size == 25

    def test_default_batch_size_when_missing(self, tmp_path: str) -> None:
        cfg = DojutsuConfig(config_path=str(tmp_path / "nonexistent.toml"))
        assert cfg.batch_size == 30


class TestMaxParallel:
    """max_parallel loaded from [pipeline].max_parallel_agents."""

    def test_loads_max_parallel_from_config(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.max_parallel == 5

    def test_default_max_parallel_when_missing(self, tmp_path: str) -> None:
        cfg = DojutsuConfig(config_path=str(tmp_path / "nonexistent.toml"))
        assert cfg.max_parallel == 3


class TestSessionTokenBudget:
    """session_token_budget loaded from [pipeline].session_token_budget."""

    def test_loads_session_token_budget(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.session_token_budget == 250_000

    def test_default_session_token_budget(self, tmp_path: str) -> None:
        cfg = DojutsuConfig(config_path=str(tmp_path / "nonexistent.toml"))
        assert cfg.session_token_budget == 500_000


# ---------------------------------------------------------------------------
# Tier / model lookups
# ---------------------------------------------------------------------------

class TestTierFor:
    """tier_for returns the tier name for a role."""

    def test_scanner_tier_from_config(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.tier_for("scanner") == "cheap"

    def test_master_hub_generator_tier(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.tier_for("master_hub_generator") == "premium"

    def test_unknown_role_returns_mid(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.tier_for("nonexistent_role") == "mid"


class TestModelFor:
    """model_for returns the model ID for role + engine."""

    def test_scanner_claude_model(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.model_for("scanner") == "claude-haiku-4-5"

    def test_aggregator_claude_model(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.model_for("aggregator") == "claude-haiku-4-5"

    def test_master_hub_generator_claude_model(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.model_for("master_hub_generator") == "claude-opus-4-6"

    def test_enricher_claude_model(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.model_for("enricher") == "claude-sonnet-4-6"

    def test_unknown_engine_falls_back(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        # Unknown engine with mid tier returns the default model
        assert cfg.model_for("enricher", engine="codex") == "claude-sonnet-4-6"


class TestContextWindowFor:
    """context_window_for returns the context window for the role's tier."""

    def test_cheap_tier_context_window(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.context_window_for("scanner") == 200_000

    def test_mid_tier_context_window(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.context_window_for("enricher") == 1_000_000

    def test_premium_tier_context_window(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.context_window_for("master_hub_generator") == 1_000_000

    def test_unknown_role_gets_mid_window(self, tmp_path: str) -> None:
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        assert cfg.context_window_for("nonexistent_role") == 1_000_000


# ---------------------------------------------------------------------------
# Defaults fallback (no config file)
# ---------------------------------------------------------------------------

class TestDefaults:
    """Falls back to defaults when config file is missing."""

    def test_default_batch_size(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.batch_size == 30

    def test_default_max_parallel(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.max_parallel == 3

    def test_default_session_token_budget(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.session_token_budget == 500_000

    def test_default_scanner_tier_is_mid(self) -> None:
        """Scanner defaults to 'mid' tier when TOML is missing."""
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.tier_for("scanner") == "mid"

    def test_default_scanner_model(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.model_for("scanner") == "claude-sonnet-4-6"

    def test_default_context_window_for_scanner(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.context_window_for("scanner") == 1_000_000

    def test_unknown_role_defaults_to_mid(self) -> None:
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        assert cfg.tier_for("totally_unknown") == "mid"
        assert cfg.model_for("totally_unknown") == "claude-sonnet-4-6"
        assert cfg.context_window_for("totally_unknown") == 1_000_000


# ---------------------------------------------------------------------------
# max_batch_for — dynamic batch sizing
# ---------------------------------------------------------------------------

class TestMaxBatchFor:
    """max_batch_for calculates files per batch from context window."""

    def test_caps_at_batch_size_for_small_files(self, tmp_path: str) -> None:
        """With small avg_loc, usable window is large => capped by batch_size."""
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        # mid tier: 1M window, avg_loc=50 (tiny files)
        result = cfg.max_batch_for("enricher", avg_loc=50)
        assert result == cfg.batch_size  # capped at 25

    def test_fewer_files_for_large_avg_loc(self, tmp_path: str) -> None:
        """With large avg_loc, tokens_per_file is high => fewer files."""
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        small = cfg.max_batch_for("enricher", avg_loc=100)
        large = cfg.max_batch_for("enricher", avg_loc=5000)
        assert large < small

    def test_fewer_files_for_cheap_tier(self, tmp_path: str) -> None:
        """Cheap tier has 200k window => fewer files than mid (1M)."""
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        # Use avg_loc large enough that cheap tier is constrained below batch_size
        cheap_batch = cfg.max_batch_for("scanner", avg_loc=2000)  # cheap tier, 200k
        mid_batch = cfg.max_batch_for("enricher", avg_loc=2000)   # mid tier, 1M
        assert cheap_batch < mid_batch

    def test_minimum_is_five(self, tmp_path: str) -> None:
        """Even with huge files, floor is 5."""
        path = _write_config(tmp_path)
        cfg = DojutsuConfig(config_path=path)
        result = cfg.max_batch_for("scanner", avg_loc=50_000)
        assert result >= 5

    def test_formula_correctness(self) -> None:
        """Verify the exact formula against known values."""
        cfg = DojutsuConfig(config_path="/nonexistent/path/dojutsu.toml")
        # Default: mid tier, 1M window, batch_size=30
        window = 1_000_000
        usable = int(window * CONTEXT_UTILIZATION) - PROMPT_OVERHEAD_TOKENS
        # usable = 600_000 - 30_000 = 570_000
        avg_loc = 500
        tokens_per_file = avg_loc * TOKENS_PER_LOC + TOOL_OVERHEAD_PER_FILE
        # tokens_per_file = 2500 + 500 = 3000
        max_files = usable // tokens_per_file
        # max_files = 570_000 // 3_000 = 190
        expected = max(5, min(max_files, 30))  # min(190, 30) = 30
        assert cfg.max_batch_for("enricher", avg_loc=500) == expected
        assert expected == 30


# ---------------------------------------------------------------------------
# Config search path
# ---------------------------------------------------------------------------

class TestConfigSearchPath:
    """_find_config respects DOJUTSU_CONFIG env var."""

    def test_env_var_override(
        self, tmp_path: str, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        config_dir = tmp_path / "custom"
        config_dir.mkdir()
        config_file = config_dir / "dojutsu.toml"
        config_file.write_text("[pipeline]\nbatch_size = 42\n")
        monkeypatch.setenv("DOJUTSU_CONFIG", str(config_dir))
        from dojutsu_config import _find_config
        result = _find_config()
        assert result == str(config_file)

    def test_env_var_nonexistent_dir_falls_through(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("DOJUTSU_CONFIG", "/nonexistent/dir/xyz")
        from dojutsu_config import _find_config
        # Should not raise, may return None or the home path
        result = _find_config()
        # Result is either None or a valid path (home config)
        if result is not None:
            assert os.path.isfile(result)


# ---------------------------------------------------------------------------
# Constants are exported
# ---------------------------------------------------------------------------

class TestConstantsExported:
    """Module-level constants are accessible."""

    def test_prompt_overhead_tokens(self) -> None:
        assert PROMPT_OVERHEAD_TOKENS == 30_000

    def test_tokens_per_loc(self) -> None:
        assert TOKENS_PER_LOC == 5

    def test_tool_overhead_per_file(self) -> None:
        assert TOOL_OVERHEAD_PER_FILE == 500

    def test_context_utilization(self) -> None:
        assert CONTEXT_UTILIZATION == 0.60
