"""Readiness trend tracking across audit runs.

Appends a readiness entry after each audit and provides trend
information (current vs. previous) when 2+ data points exist.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import TypedDict


class TrendEntry(TypedDict):
    timestamp: str
    score: float
    findings: int
    critical: int
    coverage: float | None


class TrendInfo(TypedDict):
    current: float
    previous: float
    delta: float
    direction: str


HISTORY_FILENAME = "readiness-history.jsonl"


def _history_path(audit_dir: str) -> str:
    return os.path.join(audit_dir, "data", HISTORY_FILENAME)


def append_trend(
    audit_dir: str,
    score: float,
    findings: int,
    critical: int,
    coverage: float | None = None,
) -> None:
    """Append a readiness entry to the history file.

    Creates the file and parent directories if they do not exist.
    Each line is a self-contained JSON object.
    """
    path = _history_path(audit_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    entry: TrendEntry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "score": round(score, 2),
        "findings": findings,
        "critical": critical,
        "coverage": round(coverage, 2) if coverage is not None else None,
    }

    with open(path, "a") as fh:
        fh.write(json.dumps(entry) + "\n")


def get_trend(audit_dir: str) -> TrendInfo | None:
    """Return trend info if 2+ entries exist.

    Returns a dict with current score, previous score, delta, and
    direction (``"improving"``, ``"declining"``, or ``"stable"``).
    Returns ``None`` when fewer than 2 history entries are available.
    """
    path = _history_path(audit_dir)
    if not os.path.isfile(path):
        return None

    entries: list[TrendEntry] = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            entries.append(json.loads(line))

    if len(entries) < 2:
        return None

    current = entries[-1]["score"]
    previous = entries[-2]["score"]
    delta = round(current - previous, 2)

    if delta > 0:
        direction = "improving"
    elif delta < 0:
        direction = "declining"
    else:
        direction = "stable"

    return TrendInfo(
        current=current,
        previous=previous,
        delta=delta,
        direction=direction,
    )
