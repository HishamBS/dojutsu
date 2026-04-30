"""Content invariants for scanner-prompt.md."""
from __future__ import annotations
import os

PROMPT_PATH = os.path.join(os.path.dirname(__file__), "..", "scanner-prompt.md")


def _read() -> str:
    with open(PROMPT_PATH, encoding="utf-8") as f:
        return f.read()


def test_prompt_contains_no_density_note_instruction():
    body = _read()
    assert "DENSITY_NOTE" not in body  # no qualifier — catches all forms incl. backticks


def test_prompt_does_not_set_lower_density_bound():
    body = _read()
    assert "below 1/KLOC" not in body
    assert "below 1 finding" not in body
    assert "fewer than 1 finding per KLOC" not in body


def test_prompt_explicitly_permits_zero_findings():
    body = _read()
    assert (
        "0 findings on a clean file is correct" in body
        or "Zero findings on a clean file is correct" in body
    )


def test_prompt_keeps_anti_manufacture_guidance():
    """The 'do not manufacture findings' guidance is preserved."""
    body = _read()
    assert "manufacture" in body  # the existing "do not manufacture" line is preserved


def test_prompt_keeps_upper_bound_overreport_check():
    body = _read()
    # Upper-bound noise check is preserved
    assert "60%" in body
    assert "20 findings/KLOC" in body
