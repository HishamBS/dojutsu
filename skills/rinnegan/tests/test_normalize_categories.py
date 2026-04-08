"""Tests for deterministic category normalization and finding validation."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from normalize_categories import normalize_category, normalize_findings_file, validate_finding


class TestNormalizeCategory:
    def test_canonical_slugs_unchanged(self) -> None:
        for slug in [
            "clean-code", "security", "typing", "ssot-dry", "architecture",
            "performance", "data-integrity", "refactoring", "full-stack",
            "documentation", "build",
        ]:
            assert normalize_category(slug) == slug

    def test_rule_ssot_overrides_text(self) -> None:
        # Even if LLM wrote "Clean Code", R05 means security
        assert normalize_category("Clean Code", rule="R05") == "security"
        assert normalize_category("anything", rule="R07") == "typing"
        assert normalize_category("wrong", rule="R04") == "performance"
        assert normalize_category("wrong", rule="R01") == "ssot-dry"

    def test_human_readable_normalized_without_rule(self) -> None:
        assert normalize_category("Clean Code") == "clean-code"
        assert normalize_category("Magic Numbers") == "clean-code"
        assert normalize_category("SSOT/DRY") == "ssot-dry"
        assert normalize_category("DRY Violation") == "ssot-dry"
        assert normalize_category("Strict Typing") == "typing"
        assert normalize_category("Separation of Concerns") == "architecture"

    def test_variant_formats(self) -> None:
        assert normalize_category("code_quality") == "clean-code"
        assert normalize_category("TYPE") == "typing"
        assert normalize_category("CLEAN_CODE") == "clean-code"
        assert normalize_category("PERFORMANCE") == "performance"
        assert normalize_category("SECURITY") == "security"
        assert normalize_category("DRY") == "ssot-dry"

    def test_unknown_defaults_to_clean_code(self) -> None:
        assert normalize_category("unknown_thing") == "clean-code"
        assert normalize_category("") == "clean-code"


class TestValidateFinding:
    def test_valid_finding_passes(self) -> None:
        f = {"rule": "R05", "file": "app.py", "line": 10,
             "description": "eval() usage", "severity": "high", "category": "wrong"}
        assert validate_finding(f) is True
        assert f["category"] == "security"  # SSOT from rule
        assert f["severity"] == "HIGH"  # uppercased

    def test_missing_required_field_rejected(self) -> None:
        f = {"rule": "R05", "file": "", "line": 10, "description": "x"}
        assert validate_finding(f) is False

    def test_invalid_severity_defaults_to_medium(self) -> None:
        f = {"rule": "R09", "file": "a.ts", "line": 1,
             "description": "x", "severity": "banana"}
        assert validate_finding(f) is True
        assert f["severity"] == "MEDIUM"

    def test_missing_severity_defaults_to_medium(self) -> None:
        f = {"rule": "R09", "file": "a.ts", "line": 1, "description": "x"}
        assert validate_finding(f) is True
        assert f["severity"] == "MEDIUM"


class TestNormalizeFindingsFile:
    def test_normalizes_and_validates(self) -> None:
        findings = [
            {"id": "1", "category": "Clean Code", "rule": "R09",
             "file": "a.ts", "line": 1, "description": "console.log", "severity": "MEDIUM"},
            {"id": "2", "category": "SECURITY", "rule": "R05",
             "file": "b.py", "line": 5, "description": "eval", "severity": "high"},
            {"id": "3", "category": "magic_numbers", "rule": "R13",
             "file": "c.ts", "line": 10, "description": "magic", "severity": "LOW"},
            {"id": "4", "category": "?", "rule": "R05",
             "file": "", "line": 0, "description": ""},  # invalid: empty file + description
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            for finding in findings:
                f.write(json.dumps(finding) + "\n")
            path = f.name

        try:
            count = normalize_findings_file(path)
            assert count == 3  # 4th rejected

            with open(path) as fh:
                result = [json.loads(line) for line in fh]
            assert result[0]["category"] == "clean-code"  # R09 → clean-code
            assert result[1]["category"] == "security"  # R05 → security
            assert result[1]["severity"] == "HIGH"  # uppercased
            assert result[2]["category"] == "clean-code"  # R13 → clean-code
        finally:
            os.unlink(path)
