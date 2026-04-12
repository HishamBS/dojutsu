"""Three-tier completeness check for session-resilient output validation.

Detects complete output on disk even without explicit status updates,
enabling recovery when sessions are interrupted by rate limits or
context exhaustion.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone


def _count_non_blank_lines(filepath: str) -> int:
    """Count non-blank lines in a file."""
    count = 0
    with open(filepath) as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def _write_sentinel(sentinel_path: str, line_count: int) -> None:
    """Write a .done sentinel file with auto-recovery metadata."""
    payload = {
        "lines": line_count,
        "auto_recovered": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with open(sentinel_path, "w") as f:
        json.dump(payload, f)


def validate_jsonl_integrity(filepath: str) -> tuple[int, int, str | None]:
    """Validate every non-blank line in a JSONL file is valid JSON.

    Returns (valid_lines, total_non_blank_lines, error_or_none).
    On first invalid line, returns immediately with the error message.
    Blank lines are skipped and not counted.
    """
    valid = 0
    total = 0
    with open(filepath) as f:
        for line_num, raw_line in enumerate(f, start=1):
            stripped = raw_line.strip()
            if not stripped:
                continue
            total += 1
            try:
                json.loads(stripped)
            except json.JSONDecodeError as exc:
                return valid, total, f"line {line_num}: {exc}"
            valid += 1
    return valid, total, None


def is_output_complete(output_path: str) -> bool:
    """Three-tier completeness check for an output file.

    Tier 1: Sentinel file exists and line count matches actual file.
    Tier 2: No sentinel, but file is valid JSONL -- auto-recover sentinel.
    Tier 3: No file or empty file -- incomplete.
    """
    sentinel_path = output_path + ".done"

    # Tier 1: sentinel exists
    if os.path.isfile(sentinel_path):
        try:
            with open(sentinel_path) as f:
                sentinel = json.load(f)
            expected_lines = sentinel.get("lines", -1)
            if not os.path.isfile(output_path):
                return False
            actual_lines = _count_non_blank_lines(output_path)
            return actual_lines == expected_lines
        except (json.JSONDecodeError, OSError):
            return False

    # Tier 2: no sentinel, but file exists and is non-empty
    if os.path.isfile(output_path):
        actual_lines = _count_non_blank_lines(output_path)
        if actual_lines == 0:
            return False
        valid, total, error = validate_jsonl_integrity(output_path)
        if error is None and valid == total:
            _write_sentinel(sentinel_path, actual_lines)
            return True
        return False

    # Tier 3: no file
    return False


def validate_aggregation_completeness(
    findings_path: str,
    scanner_output_dir: str,
) -> tuple[bool, str]:
    """Cross-reference findings.jsonl against scanner output files.

    Checks that the aggregated findings contain at least 50% of total
    scanner output lines. Returns (is_complete, stats_or_reason).
    """
    import glob as glob_mod

    scanner_files = glob_mod.glob(os.path.join(scanner_output_dir, "*.jsonl"))
    scanner_files = [
        f for f in scanner_files
        if not f.endswith(".done") and not f.endswith(".rejected")
    ]

    scanner_total = 0
    for sf in scanner_files:
        scanner_total += _count_non_blank_lines(sf)

    if not os.path.isfile(findings_path):
        return False, f"findings file missing: {findings_path}"

    findings_total = _count_non_blank_lines(findings_path)

    if scanner_total == 0:
        return False, "no scanner output lines found"

    ratio = findings_total / scanner_total
    stats = (
        f"findings={findings_total}, scanner_total={scanner_total}, "
        f"ratio={ratio:.1%}, scanners={len(scanner_files)}"
    )

    threshold = 0.50
    if ratio < threshold:
        return False, f"incomplete: {stats}"

    return True, stats


def validate_enrichment_completeness(
    findings_path: str,
    enriched_dir: str,
) -> tuple[list[str], list[str]]:
    """Check per-layer enrichment completeness.

    Reads findings_path to count findings per layer, then verifies that
    each layer's enriched output file is complete and contains at least
    80% of expected findings.

    Returns (complete_layers, incomplete_layers).
    """
    layer_counts: dict[str, int] = {}

    if os.path.isfile(findings_path):
        with open(findings_path) as f:
            for raw_line in f:
                stripped = raw_line.strip()
                if not stripped:
                    continue
                try:
                    finding = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                layer = finding.get("layer", "")
                if layer:
                    layer_counts[layer] = layer_counts.get(layer, 0) + 1

    complete: list[str] = []
    incomplete: list[str] = []
    enrichment_threshold = 0.80

    for layer, expected_count in layer_counts.items():
        enriched_path = os.path.join(enriched_dir, f"{layer}.jsonl")
        if is_output_complete(enriched_path):
            actual_count = _count_non_blank_lines(enriched_path)
            if actual_count >= expected_count * enrichment_threshold:
                complete.append(layer)
            else:
                incomplete.append(layer)
        else:
            incomplete.append(layer)

    return complete, incomplete
