"""Deterministic category normalization and finding validation.

Two normalization strategies (applied in order):
1. RULE_TO_CATEGORY (SSOT): R05 → security, R07 → typing, etc. Overrides whatever the scanner wrote.
2. CATEGORY_MAP (fallback): for findings where rule is unknown, normalize the text.

Also validates required fields and rejects unfixable findings.
"""
from __future__ import annotations


CANONICAL_CATEGORIES = frozenset({
    "security", "typing", "ssot-dry", "architecture", "clean-code",
    "performance", "data-integrity", "refactoring", "full-stack",
    "documentation", "build",
})

VALID_SEVERITIES = frozenset({"CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"})

# SSOT: rule → category. This is authoritative — overrides LLM scanner output.
RULE_TO_CATEGORY: dict[str, str] = {
    "R01": "ssot-dry",
    "R02": "architecture",
    "R03": "architecture",
    "R04": "performance",
    "R05": "security",
    "R07": "typing",
    "R08": "full-stack",
    "R09": "clean-code",
    "R10": "refactoring",
    "R11": "documentation",
    "R12": "data-integrity",
    "R13": "clean-code",
    "R14": "build",
    "R16": "full-stack",
}

REQUIRED_FIELDS = ("rule", "file", "line", "description")

# Map every known variant to a canonical slug.
# Keys are lowercase. Values are canonical slugs.
_CATEGORY_MAP: dict[str, str] = {
    # Canonical (pass-through)
    "security": "security",
    "typing": "typing",
    "ssot-dry": "ssot-dry",
    "architecture": "architecture",
    "clean-code": "clean-code",
    "performance": "performance",
    "data-integrity": "data-integrity",
    "refactoring": "refactoring",
    "full-stack": "full-stack",
    "documentation": "documentation",
    "build": "build",
    # Human-readable variants (LLM scanner outputs)
    "clean code": "clean-code",
    "code quality": "clean-code",
    "code_quality": "clean-code",
    "code-quality": "clean-code",
    "codequality": "clean-code",
    "magic numbers": "clean-code",
    "magic-numbers": "clean-code",
    "magic_numbers": "clean-code",
    "no magic numbers": "clean-code",
    "console statement": "clean-code",
    "strict typing": "typing",
    "strict-typing": "typing",
    "strict_typing": "typing",
    "type": "typing",
    "type safety": "typing",
    "type_safety": "typing",
    "ssot/dry": "ssot-dry",
    "ssot & dry": "ssot-dry",
    "dry": "ssot-dry",
    "dry violation": "ssot-dry",
    "dry_violation": "ssot-dry",
    "duplication": "ssot-dry",
    "separation of concerns": "architecture",
    "mirror architecture": "architecture",
    "mirror-architecture": "architecture",
    "unused-imports": "build",
    "unused imports": "build",
    # UPPERCASE variants (grep scanner on some stacks)
    "clean_code": "clean-code",
    "strict_typing": "typing",
}


def normalize_category(raw: str, rule: str = "") -> str:
    """Normalize a category string to a canonical slug.

    Strategy: if rule maps to a known category (SSOT), use that.
    Otherwise fall back to text-based normalization.
    """
    # Strategy 1: derive from rule (authoritative)
    if rule and rule in RULE_TO_CATEGORY:
        return RULE_TO_CATEGORY[rule]
    # Strategy 2: text-based normalization (fallback)
    key = raw.strip().lower()
    return _CATEGORY_MAP.get(key, "clean-code")


def validate_finding(f: dict) -> bool:
    """Validate and normalize a finding. Returns False if unfixable.

    Fixes in-place:
    - category: derived from rule (SSOT) or text-normalized
    - severity: uppercased and validated against enum
    """
    # Required fields
    for key in REQUIRED_FIELDS:
        if not f.get(key):
            return False

    # Category: SSOT from rule, fallback to text normalization
    f["category"] = normalize_category(
        f.get("category", ""), f.get("rule", "")
    )

    # Severity: normalize case and validate
    sev = (f.get("severity") or "MEDIUM").upper()
    if sev not in VALID_SEVERITIES:
        sev = "MEDIUM"
    f["severity"] = sev

    return True


def normalize_findings_file(path: str) -> int:
    """Normalize all categories in a findings.jsonl file in-place.

    Returns count of valid findings (invalid findings are removed).
    """
    import json
    import os

    findings: list[dict] = []
    rejected = 0
    with open(path) as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            finding = json.loads(stripped)
            if validate_finding(finding):
                findings.append(finding)
            else:
                rejected += 1

    if rejected > 0:
        import sys
        print(f"normalize: rejected {rejected} findings with missing required fields",
              file=sys.stderr)

    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        for finding in findings:
            f.write(json.dumps(finding) + "\n")
    os.replace(tmp, path)
    return len(findings)
