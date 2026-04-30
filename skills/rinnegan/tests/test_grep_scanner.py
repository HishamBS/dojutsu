#!/usr/bin/env python3
"""Tests for grep-scanner -- verifies types/ directory scanning and pattern coverage.

Imports grep_scanner_lib directly so pytest-cov can measure coverage.
The inventory step still uses subprocess (separate script, not under test).
"""
import json
import os
import subprocess
import sys
import tempfile
import shutil
import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
INVENTORY = os.path.join(SCRIPTS_DIR, "create-inventory.py")

# Ensure scripts dir is importable
sys.path.insert(0, SCRIPTS_DIR)
from grep_scanner_lib import (
    get_patterns_for_stack,
    load_inventory,
    scan_project,
    write_results,
    format_summary,
    CATEGORY_PREFIX,
    TYPESCRIPT_PATTERNS,
    PYTHON_PATTERNS,
    _should_skip,
    _is_comment,
    _build_finding,
)


def _setup_project(project_dir: str, files: dict[str, str], stack: str = "typescript") -> None:
    """Create a fake project with the given files and a package.json for stack detection."""
    for rel_path, content in files.items():
        full = os.path.join(project_dir, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(content)
    if stack == "typescript":
        with open(os.path.join(project_dir, "package.json"), "w") as f:
            json.dump({}, f)
    elif stack == "python":
        with open(os.path.join(project_dir, "requirements.txt"), "w") as f:
            f.write("")


def _run_pipeline(project_dir: str, audit_dir: str) -> list[dict]:
    """Run inventory (subprocess) then grep-scanner (lib import) and return findings."""
    # Inventory is a separate script -- still subprocess
    subprocess.run(
        ["python3", INVENTORY, project_dir, audit_dir],
        check=True, capture_output=True, text=True,
    )
    # Scanner -- call lib directly so coverage is tracked
    source_files, stack, file_to_layer = load_inventory(audit_dir)
    findings, _counters = scan_project(project_dir, source_files, stack, file_to_layer)
    write_results(audit_dir, findings, source_files)
    return findings


@pytest.fixture
def workspace():
    """Provide temporary project and audit directories, cleaned up after test."""
    project_dir = tempfile.mkdtemp(prefix="scanner_test_proj_")
    audit_dir = tempfile.mkdtemp(prefix="scanner_test_audit_")
    yield project_dir, audit_dir
    shutil.rmtree(project_dir, ignore_errors=True)
    shutil.rmtree(audit_dir, ignore_errors=True)


class TestTypesLayerDetection:
    """Verify that files in types/ directories are scanned and violations are detected."""

    def test_colon_any_in_types(self, workspace):
        """': any' in a types/ file should produce an R07 finding."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/models.ts": "export interface User {\n  data: any;\n}\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        type_findings = [f for f in findings if f["file"] == "types/models.ts" and f["rule"] == "R07"]
        assert len(type_findings) == 1
        assert type_findings[0]["layer"] == "types"
        assert type_findings[0]["severity"] == "HIGH"
        assert type_findings[0]["category"] == "typing"

    def test_type_alias_equals_any(self, workspace):
        """'type Foo = any' should produce an R07 finding (type alias to any)."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/aliases.ts": "export type ApiResponse = any;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        type_findings = [f for f in findings if f["file"] == "types/aliases.ts" and f["rule"] == "R07"]
        assert len(type_findings) == 1
        assert "alias" in type_findings[0]["description"].lower() or "any" in type_findings[0]["description"].lower()

    def test_generic_any_record(self, workspace):
        """'Record<string, any>' should produce an R07 finding (generic parameter)."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/maps.ts": "export type DataMap = Record<string, any>;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        type_findings = [f for f in findings if f["file"] == "types/maps.ts" and f["rule"] == "R07"]
        assert len(type_findings) >= 1
        generic_findings = [f for f in type_findings if "generic" in f["description"].lower() or "parameter" in f["description"].lower()]
        assert len(generic_findings) >= 1

    def test_generic_any_array(self, workspace):
        """'Array<any>' should produce an R07 finding."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/arrays.ts": "export type Items = Array<any>;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        type_findings = [f for f in findings if f["file"] == "types/arrays.ts" and f["rule"] == "R07"]
        assert len(type_findings) >= 1

    def test_as_any_in_types(self, workspace):
        """'as any' in a types/ file should produce an R07 finding."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/types/casting.ts": "const result = data as any;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        type_findings = [f for f in findings if f["file"] == "src/types/casting.ts" and f["rule"] == "R07"]
        assert len(type_findings) == 1
        assert "assertion" in type_findings[0]["description"].lower() or "as any" in type_findings[0]["description"].lower()

    def test_console_log_in_types(self, workspace):
        """'console.log' in a types/ file should produce an R09 finding."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/debug.ts": 'console.log("should not be here");\n',
        })
        findings = _run_pipeline(project_dir, audit_dir)
        console_findings = [f for f in findings if f["file"] == "types/debug.ts" and f["rule"] == "R09"]
        assert len(console_findings) == 1
        assert console_findings[0]["layer"] == "types"

    def test_multiple_violations_in_types(self, workspace):
        """A types file with multiple violations should produce findings for each."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/mixed.ts": (
                "export type ApiResponse = any;\n"
                "export type DataMap = Record<string, any>;\n"
                "export interface Config {\n"
                "  handler: (e: any) => void;\n"
                "}\n"
                'console.log("debug");\n'
            ),
        })
        findings = _run_pipeline(project_dir, audit_dir)
        files_findings = [f for f in findings if f["file"] == "types/mixed.ts"]
        r07_findings = [f for f in files_findings if f["rule"] == "R07"]
        r09_findings = [f for f in files_findings if f["rule"] == "R09"]
        assert len(r07_findings) >= 3, f"Expected >=3 R07 findings, got {len(r07_findings)}"
        assert len(r09_findings) == 1


class TestTypesLayerNotExcluded:
    """Verify that types files are not accidentally excluded."""

    def test_types_dir_in_inventory_as_source(self, workspace):
        """Files in types/ should be tagged SOURCE, not TEST or GENERATED."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/foo.ts": "export type Foo = string;\n",
        })
        subprocess.run(
            ["python3", INVENTORY, project_dir, audit_dir],
            check=True, capture_output=True, text=True,
        )
        inv = json.load(open(os.path.join(audit_dir, "data/inventory.json")))
        types_files = [f for f in inv["files"] if f["path"] == "types/foo.ts"]
        assert len(types_files) == 1
        assert types_files[0]["tag"] == "SOURCE"
        assert types_files[0]["layer"] == "types"

    def test_src_types_dir_in_inventory_as_source(self, workspace):
        """Files in src/types/ should also be tagged SOURCE."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/types/bar.ts": "export type Bar = number;\n",
        })
        subprocess.run(
            ["python3", INVENTORY, project_dir, audit_dir],
            check=True, capture_output=True, text=True,
        )
        inv = json.load(open(os.path.join(audit_dir, "data/inventory.json")))
        types_files = [f for f in inv["files"] if f["path"] == "src/types/bar.ts"]
        assert len(types_files) == 1
        assert types_files[0]["tag"] == "SOURCE"
        assert types_files[0]["layer"] == "types"

    def test_dts_files_in_types_are_scanned(self, workspace):
        """'.d.ts' files in types/ should be included and scanned."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/global.d.ts": "declare const config: any;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        dts_findings = [f for f in findings if f["file"] == "types/global.d.ts"]
        assert len(dts_findings) >= 1, "Expected findings in .d.ts file"


class TestNoFalsePositives:
    """Verify the new patterns do not produce false positives."""

    def test_equals_anything_not_matched(self, workspace):
        """'= anything' or '= anyFunction()' should NOT be flagged."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/utils.ts": (
                "const x = anything;\n"
                "const y = anyFunction();\n"
                "const z = any_variable;\n"
            ),
        })
        findings = _run_pipeline(project_dir, audit_dir)
        r07_findings = [f for f in findings if f["rule"] == "R07"]
        assert len(r07_findings) == 0, f"False positives: {r07_findings}"

    def test_comments_skipped_for_any(self, workspace):
        """Commented-out any usage should be skipped (R07 comment filter)."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/commented.ts": (
                "// type Foo = any;\n"
                "// const x: any = 5;\n"
                "/* Record<string, any> */\n"
            ),
        })
        findings = _run_pipeline(project_dir, audit_dir)
        r07_findings = [f for f in findings if f["rule"] == "R07"]
        assert len(r07_findings) == 0, f"Should skip commented lines, got: {r07_findings}"


class TestNoDuplicateFindings:
    """Verify patterns do not produce duplicate findings for the same line."""

    def test_no_duplicate_file_line(self, workspace):
        """Each file:line should appear at most once per rule."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "types/complex.ts": (
                "export interface Config {\n"
                "  data: any;\n"
                "  callback: (args: any[]) => void;\n"
                "}\n"
                "export type Response = Record<string, any>;\n"
            ),
        })
        findings = _run_pipeline(project_dir, audit_dir)
        seen = set()
        for f in findings:
            key = (f["file"], f["line"], f["rule"])
            assert key not in seen, f"Duplicate finding: {key}"
            seen.add(key)


class TestExistingPatternsStillWork:
    """Regression tests: existing patterns continue to work."""

    def test_console_log_detected(self, workspace):
        """console.log should still be detected in non-types files."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/components/App.tsx": 'console.log("hello");\n',
        })
        findings = _run_pipeline(project_dir, audit_dir)
        assert any(f["rule"] == "R09" for f in findings)

    def test_eval_detected(self, workspace):
        """eval() should still be detected."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/utils.ts": 'eval("code");\n',
        })
        findings = _run_pipeline(project_dir, audit_dir)
        assert any(f["rule"] == "R05" for f in findings)

    def test_localhost_detected(self, workspace):
        """Hardcoded localhost URLs should still be detected."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/config.ts": 'const url = "http://localhost:3000";\n',
        })
        findings = _run_pipeline(project_dir, audit_dir)
        assert any(f["rule"] == "R12" for f in findings)

    def test_todo_detected(self, workspace):
        """TODO markers should still be detected."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "src/service.ts": "// TODO fix this later\nconst x = 1;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        assert any(f["rule"] == "R14" for f in findings)

    def test_test_files_excluded(self, workspace):
        """Files in test directories should be excluded from scanning."""
        project_dir, audit_dir = workspace
        _setup_project(project_dir, {
            "__tests__/App.test.ts": 'console.log("test debug");\n',
            "src/service.ts": "const x = 1;\n",
        })
        findings = _run_pipeline(project_dir, audit_dir)
        test_findings = [f for f in findings if "__tests__" in f["file"]]
        assert len(test_findings) == 0


def test_meta_file_requires_directory_filename_and_content(tmp_path):
    from grep_scanner_lib import _is_meta_file

    # Positive: all three signals
    f1 = tmp_path / "scripts" / "ci" / "enforce-engineering-rules.ts"
    f1.parent.mkdir(parents=True)
    f1.write_text("const RULE_PATTERNS = [];\nconst SUPPRESSION = /@ts-nocheck/;\n")
    assert _is_meta_file("scripts/ci/enforce-engineering-rules.ts", str(tmp_path)) is True

    # Negative: production file with matching FILENAME but wrong directory
    f2 = tmp_path / "packages" / "auth" / "src" / "verify-token.ts"
    f2.parent.mkdir(parents=True)
    f2.write_text("export function verifyToken(t: string) { return t.length > 0; }\n")
    assert _is_meta_file("packages/auth/src/verify-token.ts", str(tmp_path)) is False

    # Negative: file in scripts/ci/ but no PatternDef marker
    f3 = tmp_path / "scripts" / "ci" / "release-publish.ts"
    f3.parent.mkdir(parents=True, exist_ok=True)
    f3.write_text("import { execSync } from 'node:child_process';\n")
    assert _is_meta_file("scripts/ci/release-publish.ts", str(tmp_path)) is False

    # Negative: regular source file
    f4 = tmp_path / "packages" / "h1" / "src" / "cam" / "engine.ts"
    f4.parent.mkdir(parents=True)
    f4.write_text("export class Engine {}\n")
    assert _is_meta_file("packages/h1/src/cam/engine.ts", str(tmp_path)) is False


def test_grep_scan_skips_R09_R13_R14_only_on_meta_files(tmp_path):
    from grep_scanner_lib import scan_project

    meta = tmp_path / "scripts" / "ci" / "enforce-engineering-rules.ts"
    meta.parent.mkdir(parents=True)
    meta.write_text(
        "const RULE_PATTERNS = [];\n"
        "const SUPPRESSION = /@ts-nocheck|eslint-disable/;\n"
    )

    prod = tmp_path / "packages" / "auth" / "src" / "verify-token.ts"
    prod.parent.mkdir(parents=True)
    prod.write_text("// @ts-nocheck\nexport const x: any = 1;\n")

    findings, _counts = scan_project(
        project_dir=str(tmp_path),
        source_files=[
            "scripts/ci/enforce-engineering-rules.ts",
            "packages/auth/src/verify-token.ts",
        ],
        stack="typescript",
        file_to_layer={
            "scripts/ci/enforce-engineering-rules.ts": "config",
            "packages/auth/src/verify-token.ts": "services",
        },
    )

    by_file: dict[str, set[str]] = {}
    for f in findings:
        by_file.setdefault(f["file"], set()).add(f["rule"])

    meta_rules = by_file.get("scripts/ci/enforce-engineering-rules.ts", set())
    assert "R09" not in meta_rules
    assert "R13" not in meta_rules
    assert "R14" not in meta_rules

    prod_rules = by_file.get("packages/auth/src/verify-token.ts", set())
    assert "R14" in prod_rules


# ---- Task 4: skip_string_literals flag tests --------------------------------


def test_pattern_def_supports_skip_string_literals():
    from grep_scanner_lib import PatternDef
    p = PatternDef(
        rule="R14",
        severity="CRITICAL",
        category="build",
        pattern=r"@ts-nocheck",
        description="...",
        explanation="...",
        skip_string_literals=True,
    )
    assert p.get("skip_string_literals") is True


def test_ts_nocheck_inside_regex_literal_is_not_flagged(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "rule-detector.ts"
    f.parent.mkdir(parents=True)
    f.write_text(
        'const SUPPRESSION_PATTERN = /@ts-nocheck|eslint-disable/;\n'
        'export function isOk(): boolean { return true; }\n'
    )
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/rule-detector.ts"],
        stack="typescript",
        file_to_layer={"src/rule-detector.ts": "services"},
    )
    rules = {f["rule"] for f in findings}
    assert "R14" not in rules


def test_ts_nocheck_inside_string_literal_is_not_flagged(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "doc.ts"
    f.parent.mkdir(parents=True)
    f.write_text(
        'export const docMessage = "use @ts-nocheck for tricky generated files";\n'
    )
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/doc.ts"],
        stack="typescript",
        file_to_layer={"src/doc.ts": "services"},
    )
    rules = {f["rule"] for f in findings}
    assert "R14" not in rules


def test_ts_nocheck_as_actual_directive_is_flagged(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "broken.ts"
    f.parent.mkdir(parents=True)
    f.write_text("// @ts-nocheck\nexport const x: any = 1;\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/broken.ts"],
        stack="typescript",
        file_to_layer={"src/broken.ts": "services"},
    )
    rules = {f["rule"] for f in findings}
    assert "R14" in rules


@pytest.mark.xfail(reason="known limitation: per-line stripping does not handle multi-line template literals")
def test_ts_nocheck_inside_multiline_template_is_not_flagged(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "doc.ts"
    f.parent.mkdir(parents=True)
    f.write_text(
        "export const tutorial = `\n"
        "Use @ts-nocheck for tricky generated files\n"
        "`;\n"
    )
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/doc.ts"],
        stack="typescript",
        file_to_layer={"src/doc.ts": "services"},
    )
    rules = {f["rule"] for f in findings}
    assert "R14" not in rules


# ---- Task 6: literal R12/R13 grep patterns ----------------------------------


def test_grep_catches_zero_repeat_40_placeholder(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "x.ts"
    f.parent.mkdir(parents=True)
    f.write_text("const fakeHash = '0'.repeat(40);\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/x.ts"],
        stack="typescript",
        file_to_layer={"src/x.ts": "services"},
    )
    assert any(r["rule"] == "R12" for r in findings)


def test_grep_catches_zero_repeat_64_placeholder(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "x.ts"
    f.parent.mkdir(parents=True)
    f.write_text('const fakeSha = "0".repeat(64);\n')
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/x.ts"],
        stack="typescript",
        file_to_layer={"src/x.ts": "services"},
    )
    assert any(r["rule"] == "R12" for r in findings)


def test_grep_catches_localhost_in_non_test_file(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "client.ts"
    f.parent.mkdir(parents=True)
    f.write_text("const apiBase = 'http://localhost:8080/api';\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/client.ts"],
        stack="typescript",
        file_to_layer={"src/client.ts": "services"},
    )
    assert any(r["rule"] == "R12" for r in findings)


def test_grep_skips_localhost_in_test_file(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "src" / "client.test.ts"
    f.parent.mkdir(parents=True)
    f.write_text("const apiBase = 'http://localhost:8080/api';\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["src/client.test.ts"],
        stack="typescript",
        file_to_layer={"src/client.test.ts": "tests"},
    )
    # No R12 finding with 'localhost' substring on the test file
    assert not any(r["rule"] == "R12" and "localhost" in r["snippet"] for r in findings)


def test_grep_catches_humain_sdk_package_literal(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "scripts" / "release.ts"
    f.parent.mkdir(parents=True)
    f.write_text("const tsPackage = '@humain/sdk';\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["scripts/release.ts"],
        stack="typescript",
        file_to_layer={"scripts/release.ts": "config"},
    )
    assert any(r["rule"] == "R13" for r in findings)


def test_grep_catches_h1_routes_filename_literal(tmp_path):
    from grep_scanner_lib import scan_project
    f = tmp_path / "scripts" / "loader.ts"
    f.parent.mkdir(parents=True)
    f.write_text("const path = '.h1-routes.json';\n")
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["scripts/loader.ts"],
        stack="typescript",
        file_to_layer={"scripts/loader.ts": "config"},
    )
    assert any(r["rule"] == "R13" for r in findings)


def test_grep_skips_sdk_package_literal_in_meta_file(tmp_path):
    """R13 SDK-package pattern must not fire on files classified as meta-files."""
    from grep_scanner_lib import scan_project
    # Construct a file that passes all three meta-file signals:
    # 1. directory: scripts/ci/
    # 2. filename:  enforce-engineering-rules.ts
    # 3. content:   contains 'PatternDef'
    ci_dir = tmp_path / "scripts" / "ci"
    ci_dir.mkdir(parents=True)
    meta_file = ci_dir / "enforce-engineering-rules.ts"
    meta_file.write_text(
        "// PatternDef\n"
        "const pkg = '@humain/sdk';\n"
    )
    findings, _ = scan_project(
        project_dir=str(tmp_path),
        source_files=["scripts/ci/enforce-engineering-rules.ts"],
        stack="typescript",
        file_to_layer={"scripts/ci/enforce-engineering-rules.ts": "config"},
    )
    r13_findings = [r for r in findings if r["rule"] == "R13"]
    assert not r13_findings
