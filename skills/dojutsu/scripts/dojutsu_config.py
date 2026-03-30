"""Dojutsu SSOT config loader.

Reads dojutsu.toml — the single source of truth for all pipeline settings.
Every pipeline script imports this instead of hardcoding values.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

# Python 3.11+ has tomllib, earlier versions need tomli
if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None  # type: ignore[assignment]


_config_cache: dict[str, Any] | None = None


def _find_config_path() -> Path:
    """Find dojutsu.toml — look in skill dir, then plugin dir."""
    # 1. Relative to this script: ../dojutsu.toml
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    config = skill_dir / "dojutsu.toml"
    if config.exists():
        return config

    # 2. Check common install locations
    for base in [
        Path.home() / ".coding-agent" / "skills" / "dojutsu",
        Path.home() / ".claude" / "commands" / "dojutsu",
        Path.home() / ".codex" / "skills" / "dojutsu",
    ]:
        config = base / "dojutsu.toml"
        if config.exists():
            return config

    raise FileNotFoundError(
        "dojutsu.toml not found. Run setup.sh to install the dojutsu pipeline."
    )


def load_config() -> dict[str, Any]:
    """Load and cache dojutsu.toml."""
    global _config_cache
    if _config_cache is not None:
        return _config_cache

    if tomllib is None:
        raise ImportError(
            "Python 3.11+ or the 'tomli' package is required to read dojutsu.toml. "
            "Install with: pip install tomli"
        )

    config_path = _find_config_path()
    with open(config_path, "rb") as f:
        _config_cache = tomllib.load(f)
    return _config_cache


def get(key: str, default: Any = None) -> Any:
    """Get a dotted config key. E.g., get('pipeline.batch_size') → 30."""
    config = load_config()
    parts = key.split(".")
    current = config
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return default
    return current


def get_model_for_task(task: str, engine: str | None = None) -> str:
    """Resolve a task to its model ID.

    E.g., get_model_for_task('scanner') → 'claude-haiku-4-5'
    E.g., get_model_for_task('scanner', engine='codex') → 'gpt-5.4-mini'
    """
    config = load_config()
    tier = config["models"]["assignments"].get(task, "mid")
    if engine is None:
        engine = config["dispatch"]["default_engine"]
    return config["models"]["tiers"][tier].get(engine, "")


def get_model_tier_for_task(task: str) -> str:
    """Get the tier name for a task. E.g., 'scanner' → 'cheap'."""
    config = load_config()
    return config["models"]["assignments"].get(task, "mid")


def get_native_model_hint(task: str) -> str:
    """Get the Claude Code Agent model parameter for a task.

    Maps tier → Claude Code model name:
      cheap → 'haiku'
      mid → 'sonnet'
      premium → 'opus'
    """
    tier = get_model_tier_for_task(task)
    tier_to_hint = {"cheap": "haiku", "mid": "sonnet", "premium": "opus"}
    return tier_to_hint.get(tier, "sonnet")


def get_dispatch_mode() -> str:
    """Return 'native' or 'agent-mux'."""
    return get("dispatch.mode", "native")


def get_batch_size() -> int:
    """Return scanner batch size."""
    return get("pipeline.batch_size", 30)


def get_max_parallel() -> int:
    """Return max parallel agent dispatches."""
    return get("pipeline.max_parallel_agents", 3)


def get_timeout(task: str) -> int:
    """Return timeout for a task in seconds."""
    return get(f"timeouts.{task}", 600)


def get_always_scan_layers() -> list[str]:
    """Return layers that always get LLM-scanned."""
    return get("always_scan_layers.layers", [])


def get_progress_prefix() -> str:
    """Return progress output prefix."""
    return get("pipeline.progress_prefix", "[dojutsu]")
