"""Tests for standalone Dojutsu export parity."""
from __future__ import annotations

import importlib.util
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[6]
MODULE_PATH = ROOT / "scripts" / "export-dojutsu-standalone.py"

spec = importlib.util.spec_from_file_location("export_dojutsu_standalone", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sync_distribution = module.sync_distribution


def test_standalone_export_round_trips_cleanly() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "dojutsu"
        os.makedirs(dest, exist_ok=True)
        changed = sync_distribution(dest, check=False)
        assert changed == ["rinnegan", "byakugan", "rasengan", "sharingan", "dojutsu"]
        assert sync_distribution(dest, check=True) == []
