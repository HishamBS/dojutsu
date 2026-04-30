"""Content invariants for aggregator-prompt.md."""
from __future__ import annotations
import os

PROMPT_PATH = os.path.join(os.path.dirname(__file__), "..", "aggregator-prompt.md")


def _read() -> str:
    with open(PROMPT_PATH, encoding="utf-8") as f:
        return f.read()


def test_rule1_dedupes_by_file_line_AND_rule():
    """Rule 1 must include rule in the dedup key. Different rules at same line are kept separate."""
    body = _read()
    # Accept either explicit form
    assert (
        "exact same `file` AND `line` AND `rule`" in body
        or "same file, line, AND rule" in body
        or "(`file`, `line`, `rule`)" in body
    )


def test_rule1_explicit_about_different_rules_same_line():
    """Explicit guidance: when (file, line) matches but rule differs, keep all."""
    body = _read()
    assert (
        "different rules at the same line are separate violations" in body
        or "When `(file, line)` matches but `rule` differs, keep all" in body
    )
