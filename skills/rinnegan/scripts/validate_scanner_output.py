"""Post-scanner output validation. Rejects invalid findings before aggregation."""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize_categories import (
    CANONICAL_CATEGORIES,
    REQUIRED_FIELDS,
    VALID_SEVERITIES,
    normalize_category,
)
DENSITY_RULE_THRESHOLD = 0.60  # warn if any single rule exceeds 60% of findings


def validate_scanner_file(
    scanner_file: str,
    inventory_files: set[str] | None = None,
) -> tuple[int, int, list[str]]:
    """Validate a scanner output JSONL file.

    Returns (valid_count, rejected_count, warnings).
    Rewrites the file in-place with only valid findings.
    Writes rejected findings to {scanner_file}.rejected.
    """
    valid: list[dict[str, object]] = []
    rejected: list[dict[str, object]] = []
    warnings: list[str] = []
    line_num = 0

    with open(scanner_file) as f:
        for raw_line in f:
            line_num += 1
            stripped = raw_line.strip()
            if not stripped:
                continue

            # Check 1: valid JSON
            try:
                finding = json.loads(stripped)
            except json.JSONDecodeError:
                rejected.append({"_raw": stripped, "_reason": "invalid_json", "_line": line_num})
                continue

            if not isinstance(finding, dict):
                rejected.append({"_raw": stripped, "_reason": "not_a_dict", "_line": line_num})
                continue

            # Check 2: required fields present
            missing = [k for k in REQUIRED_FIELDS if not finding.get(k)]
            if missing:
                finding["_reason"] = f"missing_fields:{','.join(missing)}"
                finding["_line"] = line_num
                rejected.append(finding)
                continue

            # Check 7: line number is positive integer
            line_val = finding.get("line")
            if not isinstance(line_val, int) or line_val <= 0:
                finding["_reason"] = f"invalid_line_number:{line_val}"
                finding["_line"] = line_num
                rejected.append(finding)
                continue

            # Check 5: file path exists in inventory (reject if inventory provided)
            file_path = str(finding.get("file", ""))
            if inventory_files is not None and file_path not in inventory_files:
                finding["_reason"] = f"phantom_file:{file_path}"
                finding["_line"] = line_num
                rejected.append(finding)
                continue

            # Check 3: category normalization (fix, not reject)
            raw_category = str(finding.get("category", ""))
            rule = str(finding.get("rule", ""))
            normalized = normalize_category(raw_category, rule)
            if normalized != raw_category:
                finding["category"] = normalized

            # Check 4: severity normalization (fix to MEDIUM if invalid)
            raw_severity = str(finding.get("severity", "")).upper()
            if raw_severity not in VALID_SEVERITIES:
                finding["severity"] = "MEDIUM"
            else:
                finding["severity"] = raw_severity

            valid.append(finding)

    # Check 6: density warning (per-rule > 60%)
    if valid:
        from collections import Counter
        rule_counts: Counter[str] = Counter(str(f.get("rule", "")) for f in valid)
        total = len(valid)
        for rule_id, count in rule_counts.most_common():
            ratio = count / total
            if ratio > DENSITY_RULE_THRESHOLD:
                warnings.append(
                    f"Rule {rule_id} produces {count}/{total} findings "
                    f"({ratio:.0%}), exceeding {DENSITY_RULE_THRESHOLD:.0%} threshold. "
                    f"Check for over-reporting."
                )

    # Write valid findings back to the original file
    tmp = scanner_file + ".tmp"
    with open(tmp, "w") as f:
        for finding in valid:
            f.write(json.dumps(finding) + "\n")
    os.replace(tmp, scanner_file)

    # Write rejected findings to .rejected file
    if rejected:
        with open(scanner_file + ".rejected", "w") as f:
            for entry in rejected:
                f.write(json.dumps(entry, default=str) + "\n")
    elif os.path.exists(scanner_file + ".rejected"):
        os.remove(scanner_file + ".rejected")

    return len(valid), len(rejected), warnings


def load_inventory_files(inventory_path: str) -> set[str]:
    """Load the set of known file paths from inventory.json."""
    with open(inventory_path) as f:
        inv = json.load(f)
    files = inv.get("files", [])
    # inventory.json stores files as list of dicts with "path" key
    if isinstance(files, list):
        return {f["path"] for f in files if isinstance(f, dict) and "path" in f}
    # fallback: dict with path keys
    if isinstance(files, dict):
        return set(files.keys())
    return set()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <scanner_file> [inventory.json]", file=sys.stderr)
        sys.exit(1)

    scanner_path = sys.argv[1]
    inv_files: set[str] | None = None
    if len(sys.argv) >= 3:
        inv_files = load_inventory_files(sys.argv[2])

    valid_count, rejected_count, warns = validate_scanner_file(scanner_path, inv_files)
    print(f"validate: {valid_count} valid, {rejected_count} rejected")
    for w in warns:
        print(f"  WARNING: {w}")
    if rejected_count > 0:
        print(f"  Rejected findings written to: {scanner_path}.rejected")
