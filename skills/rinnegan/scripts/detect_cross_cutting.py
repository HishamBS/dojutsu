"""Deterministic cross-cutting detection. Groups by (rule, search_pattern).

Replaces the LLM-based Jaccard similarity approach in aggregator-prompt.md
with a simple, reliable grouping that never fails silently.
"""
from __future__ import annotations

from collections import defaultdict


def detect_groups(
    findings: list[dict],
    min_files: int = 3,
) -> list[dict]:
    """Group findings by (rule, pattern). Return groups spanning min_files+ files.

    Mutates findings in-place: sets cross_cutting and cross_cutting_group fields.
    Returns list of group summaries.
    """
    groups_map: dict[str, list[dict]] = defaultdict(list)

    for f in findings:
        # Group key: rule + first 60 chars of search_pattern or description
        pattern = f.get("search_pattern") or f.get("description", "")[:60]
        key = f"{f.get('rule', 'unknown')}|{pattern}"
        groups_map[key].append(f)

    groups: list[dict] = []
    for key, members in groups_map.items():
        unique_files = {m["file"] for m in members}
        if len(unique_files) < min_files:
            continue

        rule = members[0].get("rule", "unknown")
        desc = members[0].get("description", "")[:60]
        group_name = f"{rule} across {len(unique_files)} files"

        groups.append({
            "group": group_name,
            "rule": rule,
            "description": desc,
            "count": len(members),
            "files": len(unique_files),
            "finding_ids": [m.get("id", "") for m in members],
        })

        for m in members:
            m["cross_cutting"] = True
            m["cross_cutting_group"] = group_name

    return sorted(groups, key=lambda g: g["count"], reverse=True)


def apply_cross_cutting(findings_path: str, min_files: int = 3) -> int:
    """Read findings.jsonl, apply cross-cutting detection, write back. Returns group count."""
    import json
    import os

    findings: list[dict] = []
    with open(findings_path) as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                findings.append(json.loads(stripped))

    groups = detect_groups(findings, min_files=min_files)

    tmp = findings_path + ".tmp"
    with open(tmp, "w") as f:
        for finding in findings:
            f.write(json.dumps(finding) + "\n")
    os.replace(tmp, findings_path)

    return len(groups)
