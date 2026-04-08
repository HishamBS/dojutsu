"""Deterministic category normalization. Lookup table, not LLM.

Maps all known category variants (LLM outputs, uppercase grep, human-readable)
to the 11 canonical slugs defined in finding-schema.md.
"""
from __future__ import annotations


CANONICAL_CATEGORIES = frozenset({
    "security", "typing", "ssot-dry", "architecture", "clean-code",
    "performance", "data-integrity", "refactoring", "full-stack",
    "documentation", "build",
})

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


def normalize_category(raw: str) -> str:
    """Normalize a category string to a canonical slug.

    Returns the canonical slug if found, otherwise defaults to 'clean-code'.
    """
    key = raw.strip().lower()
    return _CATEGORY_MAP.get(key, "clean-code")


def normalize_findings_file(path: str) -> int:
    """Normalize all categories in a findings.jsonl file in-place. Returns count."""
    import json
    import os

    findings: list[dict] = []
    with open(path) as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            finding = json.loads(stripped)
            finding["category"] = normalize_category(finding.get("category", ""))
            findings.append(finding)

    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        for finding in findings:
            f.write(json.dumps(finding) + "\n")
    os.replace(tmp, path)
    return len(findings)
