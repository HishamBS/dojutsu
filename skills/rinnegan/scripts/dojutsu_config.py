"""TOML config reader for the dojutsu pipeline.

Loads settings from dojutsu.toml (batch sizes, model assignments, context
windows, token budgets) and exposes them through a typed DojutsuConfig class.
Falls back to sensible defaults when the config file is missing.
"""
from __future__ import annotations

import os
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

# ---------------------------------------------------------------------------
# Module-level constants — exported for use by other pipeline modules
# ---------------------------------------------------------------------------

PROMPT_OVERHEAD_TOKENS: int = 30_000
"""Scanner prompt + rules reference + system prompt overhead."""

TOKENS_PER_LOC: int = 5
"""Approximate tokens per line of code (~4 tokens/line + tool call overhead)."""

TOOL_OVERHEAD_PER_FILE: int = 500
"""Read tool call framing per file."""

CONTEXT_UTILIZATION: float = 0.60
"""Fraction of model context window used for file content."""

# ---------------------------------------------------------------------------
# Default values — used when TOML is missing or incomplete
# ---------------------------------------------------------------------------

_DEFAULT_BATCH_SIZE: int = 30
_DEFAULT_MAX_PARALLEL: int = 3
_DEFAULT_SESSION_TOKEN_BUDGET: int = 500_000
_DEFAULT_TIER: str = "mid"
_DEFAULT_MODEL: str = "claude-sonnet-4-6"

_DEFAULT_CONTEXT_WINDOWS: dict[str, int] = {
    "cheap": 200_000,
    "mid": 1_000_000,
    "premium": 1_000_000,
}

_DEFAULT_TIER_MODELS: dict[str, dict[str, str]] = {
    "cheap": {"claude": "claude-haiku-4-5"},
    "mid": {"claude": "claude-sonnet-4-6"},
    "premium": {"claude": "claude-opus-4-6"},
}

_TIER_TO_SHORT_NAME: dict[str, str] = {
    "cheap": "haiku",
    "mid": "sonnet",
    "premium": "opus",
}

_DEFAULT_ASSIGNMENTS: dict[str, str] = {
    "scanner": "mid",
    "aggregator": "cheap",
    "enricher": "mid",
    "layer_generator": "mid",
    "master_hub_generator": "premium",
    "cross_cutting_generator": "mid",
    "impact_analyst": "mid",
    "narrator": "premium",
    "scorecard_generator": "mid",
    "deployment_planner": "mid",
    "fixer": "mid",
    "verifier": "mid",
}


def _find_config() -> str | None:
    """Locate dojutsu.toml using the config search path.

    Search order:
        1. ``$DOJUTSU_CONFIG/dojutsu.toml`` (env var override)
        2. ``~/.config/spsm/skills/dojutsu/dojutsu.toml``

    Returns:
        Absolute path to the config file, or ``None`` if not found.
    """
    env_dir = os.environ.get("DOJUTSU_CONFIG")
    if env_dir:
        candidate = os.path.join(env_dir, "dojutsu.toml")
        if os.path.isfile(candidate):
            return candidate

    home_candidate = os.path.join(
        os.path.expanduser("~"),
        ".config", "spsm", "skills", "dojutsu", "dojutsu.toml",
    )
    if os.path.isfile(home_candidate):
        return home_candidate

    return None


class DojutsuConfig:
    """Typed accessor for dojutsu pipeline configuration.

    Loads and caches the parsed TOML data on construction. Every accessor
    falls back to built-in defaults when the key is missing or the file
    does not exist, so the pipeline always has a working configuration.
    """

    def __init__(self, config_path: str | None = None) -> None:
        resolved = config_path or _find_config()
        if resolved and os.path.isfile(resolved):
            with open(resolved, "rb") as fh:
                self._data: dict[str, Any] = tomllib.load(fh)
        else:
            self._data = {}

    # -- Scalar pipeline settings -----------------------------------------------

    @property
    def batch_size(self) -> int:
        """Maximum files per scanner agent dispatch."""
        return int(
            self._data.get("pipeline", {}).get("batch_size", _DEFAULT_BATCH_SIZE)
        )

    @property
    def max_parallel(self) -> int:
        """Maximum concurrent agent dispatches."""
        return int(
            self._data.get("pipeline", {}).get(
                "max_parallel_agents", _DEFAULT_MAX_PARALLEL,
            )
        )

    @property
    def session_token_budget(self) -> int:
        """Total token budget before auto-pause."""
        return int(
            self._data.get("pipeline", {}).get(
                "session_token_budget", _DEFAULT_SESSION_TOKEN_BUDGET,
            )
        )

    # -- Tier / model / context lookups -----------------------------------------

    def tier_for(self, role: str) -> str:
        """Return the tier name for *role* (e.g. ``"cheap"``, ``"mid"``, ``"premium"``)."""
        assignments: dict[str, str] = self._data.get("models", {}).get(
            "assignments", {},
        )
        tier = assignments.get(role)
        if tier is not None:
            return str(tier)
        return _DEFAULT_ASSIGNMENTS.get(role, _DEFAULT_TIER)

    def model_for(self, role: str, engine: str = "claude") -> str:
        """Return the model ID for *role* under *engine*."""
        tier_name = self.tier_for(role)
        tiers: dict[str, Any] = self._data.get("models", {}).get("tiers", {})
        tier_data: dict[str, str] = tiers.get(tier_name, {})
        model = tier_data.get(engine)
        if model is not None:
            return str(model)
        # Fall back to built-in tier models
        fallback_tier = _DEFAULT_TIER_MODELS.get(tier_name, {})
        return fallback_tier.get(engine, _DEFAULT_MODEL)

    def enforce_model_directive(self, role: str, engine: str = "claude") -> str:
        """Return the literal Agent-tool directive for the role's tier.

        Guardrail only. The orchestrator reads this and chooses to comply.
        Rinnegan does not enforce dispatch-time model selection.

        Raises KeyError if the role is not in assignments.
        """
        all_assignments = {**_DEFAULT_ASSIGNMENTS}
        all_assignments.update(
            self._data.get("models", {}).get("assignments", {})
        )
        if role not in all_assignments:
            raise KeyError(role)
        tier = self.tier_for(role)
        return f'model: "{_TIER_TO_SHORT_NAME[tier]}"'

    def context_window_for(self, role: str) -> int:
        """Return the context window (tokens) for the tier assigned to *role*."""
        tier_name = self.tier_for(role)
        # Check TOML for context_windows override
        tiers: dict[str, Any] = self._data.get("models", {}).get("tiers", {})
        tier_data: dict[str, Any] = tiers.get(tier_name, {})
        window = tier_data.get("context_window")
        if window is not None:
            return int(window)
        return _DEFAULT_CONTEXT_WINDOWS.get(tier_name, _DEFAULT_CONTEXT_WINDOWS["mid"])

    # -- Derived batch sizing ---------------------------------------------------

    def max_batch_for(self, role: str, avg_loc: int = 500) -> int:
        """Calculate maximum files per batch based on model context window.

        Uses the formula::

            usable = int(window * CONTEXT_UTILIZATION) - PROMPT_OVERHEAD_TOKENS
            tokens_per_file = avg_loc * TOKENS_PER_LOC + TOOL_OVERHEAD_PER_FILE
            max_files = usable // tokens_per_file
            return max(5, min(max_files, self.batch_size))
        """
        window = self.context_window_for(role)
        usable = int(window * CONTEXT_UTILIZATION) - PROMPT_OVERHEAD_TOKENS
        tokens_per_file = avg_loc * TOKENS_PER_LOC + TOOL_OVERHEAD_PER_FILE
        max_files = usable // tokens_per_file
        return max(5, min(max_files, self.batch_size))
