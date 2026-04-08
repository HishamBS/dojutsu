"""Tests for deterministic category normalization."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from normalize_categories import normalize_category, normalize_findings_file


class TestNormalizeCategory:
    def test_canonical_slugs_unchanged(self) -> None:
        for slug in [
            "clean-code", "security", "typing", "ssot-dry", "architecture",
            "performance", "data-integrity", "refactoring", "full-stack",
            "documentation", "build",
        ]:
            assert normalize_category(slug) == slug

    def test_human_readable_normalized(self) -> None:
        assert normalize_category("Clean Code") == "clean-code"
        assert normalize_category("Magic Numbers") == "clean-code"
        assert normalize_category("SSOT/DRY") == "ssot-dry"
        assert normalize_category("DRY Violation") == "ssot-dry"
        assert normalize_category("Strict Typing") == "typing"
        assert normalize_category("Separation of Concerns") == "architecture"

    def test_variant_formats(self) -> None:
        assert normalize_category("code_quality") == "clean-code"
        assert normalize_category("code-quality") == "clean-code"
        assert normalize_category("magic_numbers") == "clean-code"
        assert normalize_category("TYPE") == "typing"
        assert normalize_category("CLEAN_CODE") == "clean-code"
        assert normalize_category("PERFORMANCE") == "performance"
        assert normalize_category("SECURITY") == "security"
        assert normalize_category("DRY") == "ssot-dry"

    def test_whitespace_stripped(self) -> None:
        assert normalize_category("  clean-code  ") == "clean-code"
        assert normalize_category(" Security ") == "security"

    def test_unknown_defaults_to_clean_code(self) -> None:
        assert normalize_category("unknown_thing") == "clean-code"
        assert normalize_category("") == "clean-code"


class TestNormalizeFindingsFile:
    def test_normalizes_in_place(self) -> None:
        findings = [
            {"id": "1", "category": "Clean Code", "rule": "R09"},
            {"id": "2", "category": "SECURITY", "rule": "R05"},
            {"id": "3", "category": "magic_numbers", "rule": "R13"},
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            for finding in findings:
                f.write(json.dumps(finding) + "\n")
            path = f.name

        try:
            count = normalize_findings_file(path)
            assert count == 3

            with open(path) as f:
                result = [json.loads(line) for line in f]
            assert result[0]["category"] == "clean-code"
            assert result[1]["category"] == "security"
            assert result[2]["category"] == "clean-code"
        finally:
            os.unlink(path)
