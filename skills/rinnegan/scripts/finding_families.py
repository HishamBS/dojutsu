#!/usr/bin/env python3
"""Deterministically collapse repeat structural findings into root-cause families."""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from typing import Any


SEVERITY_ORDER = {
    "CRITICAL": 0,
    "HIGH": 1,
    "MEDIUM": 2,
    "LOW": 3,
    "REVIEW": 4,
}

DEMOTION_MAP = {
    "CRITICAL": "HIGH",
    "HIGH": "MEDIUM",
    "MEDIUM": "LOW",
    "LOW": "LOW",
    "REVIEW": "REVIEW",
}

ROOT_CAUSE_RULES = {"R01"}
MIN_DISTINCT_FILES = 2


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not os.path.isfile(path):
        return rows
    with open(path) as fh:
        for raw_line in fh:
            stripped = raw_line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def _write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    with open(path, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def _normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.lower()
    text = re.sub(r"`[^`]+`", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\b\d+\b", " ", text)
    return " ".join(text.split())


def _pattern_key(finding: dict[str, Any]) -> str:
    for field in ("search_pattern", "current_code", "snippet", "description"):
        normalized = _normalize_text(finding.get(field))
        if normalized:
            return normalized
    return _normalize_text(finding.get("id", ""))


def _severity_for_sort(finding: dict[str, Any]) -> str:
    original = finding.get("original_severity")
    if isinstance(original, str) and original in SEVERITY_ORDER:
        return original
    severity = str(finding.get("severity", "MEDIUM"))
    if severity in SEVERITY_ORDER:
        return severity
    return "MEDIUM"


def _root_sort_key(finding: dict[str, Any]) -> tuple[int, int, str, int, str]:
    severity = _severity_for_sort(finding)
    phase = finding.get("phase", 10)
    try:
        phase_num = int(phase)
    except (TypeError, ValueError):
        phase_num = 10
    line = finding.get("line", 0)
    try:
        line_num = int(line)
    except (TypeError, ValueError):
        line_num = 0
    return (
        SEVERITY_ORDER.get(severity, 99),
        phase_num,
        str(finding.get("file", "")),
        line_num,
        str(finding.get("id", "")),
    )


def _clear_family_fields(finding: dict[str, Any]) -> None:
    for field in ("family_id", "parent_finding_id", "is_root_cause"):
        if field in finding:
            del finding[field]
    original = finding.get("original_severity")
    if isinstance(original, str) and original in SEVERITY_ORDER:
        finding["severity"] = original
    if "original_severity" in finding:
        del finding["original_severity"]


def _family_candidates(findings: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for finding in findings:
        rule = str(finding.get("rule", "")).strip()
        if rule not in ROOT_CAUSE_RULES:
            continue
        if str(finding.get("severity", "")) == "REVIEW":
            continue
        key = _pattern_key(finding)
        if not key:
            continue
        groups[(rule, key)].append(finding)
    return groups


def collapse_finding_families(audit_dir: str) -> dict[str, Any]:
    findings_path = os.path.join(audit_dir, "data", "findings.jsonl")
    findings = _load_jsonl(findings_path)
    if not findings:
        return {
            "families_created": 0,
            "root_causes": 0,
            "subordinate_findings": 0,
            "family_ids": [],
        }

    for finding in findings:
        _clear_family_fields(finding)

    candidates = _family_candidates(findings)
    families: list[dict[str, Any]] = []
    family_index = 1

    for (_rule, _pattern), members in sorted(
        candidates.items(),
        key=lambda item: (
            item[0][0],
            item[0][1],
            min(_root_sort_key(member) for member in item[1]),
        ),
    ):
        distinct_files = sorted({str(member.get("file", "")) for member in members if str(member.get("file", ""))})
        if len(distinct_files) < MIN_DISTINCT_FILES:
            continue

        ordered = sorted(members, key=_root_sort_key)
        root = ordered[0]
        subordinates = ordered[1:]
        family_id = f"FAM-{family_index:03d}"
        family_index += 1

        root["family_id"] = family_id
        root["is_root_cause"] = True

        subordinate_ids: list[str] = []
        for subordinate in subordinates:
            original_severity = _severity_for_sort(subordinate)
            subordinate["family_id"] = family_id
            subordinate["parent_finding_id"] = root.get("id", "")
            subordinate["is_root_cause"] = False
            subordinate["original_severity"] = original_severity
            subordinate["severity"] = DEMOTION_MAP.get(original_severity, "LOW")
            subordinate_ids.append(str(subordinate.get("id", "")))

        families.append(
            {
                "id": family_id,
                "rule": root.get("rule", ""),
                "pattern_key": _pattern,
                "root_finding_id": root.get("id", ""),
                "root_severity": _severity_for_sort(root),
                "member_finding_ids": [str(member.get("id", "")) for member in ordered],
                "subordinate_finding_ids": subordinate_ids,
                "distinct_files": distinct_files,
                "family_size": len(ordered),
                "description": str(root.get("description", "")),
            }
        )

    _write_jsonl(findings_path, findings)
    families_path = os.path.join(audit_dir, "data", "finding-families.json")
    os.makedirs(os.path.dirname(families_path), exist_ok=True)
    with open(families_path, "w") as fh:
        json.dump(
            {
                "families": families,
                "summary": {
                    "families_created": len(families),
                    "root_causes": len(families),
                    "subordinate_findings": sum(len(f["subordinate_finding_ids"]) for f in families),
                },
            },
            fh,
            indent=2,
        )
        fh.write("\n")

    return {
        "families_created": len(families),
        "root_causes": len(families),
        "subordinate_findings": sum(len(f["subordinate_finding_ids"]) for f in families),
        "family_ids": [family["id"] for family in families],
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: finding_families.py <audit_dir>")
        return 1
    audit_dir = os.path.abspath(argv[1])
    result = collapse_finding_families(audit_dir)
    print(
        "FAMILY_COLLAPSE_COMPLETE "
        f"families={result['families_created']} "
        f"subordinates={result['subordinate_findings']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
