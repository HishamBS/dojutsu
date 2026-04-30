"""Recall harness — runs the deterministic grep scanner against the synthetic
fixture project and asserts every grep-detectable expected finding is caught.

LLM-only rules are documented in expected-findings.json but not asserted here
(LLM dispatches are integration-level). Task 13's per-rule baseline preservation
gate covers LLM-only rules at acceptance time.

"any" entries in expected-findings.json are also excluded from the assertion:
they indicate findings that may be caught by grep but are not required to be,
because the LLM scanner covers them as a fallback.
"""
from __future__ import annotations
import json
import os
import sys

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS_DIR)

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "synthetic-project")


def test_grep_scanner_catches_all_grep_required_expected_findings():
    from grep_scanner_lib import scan_project
    expected = json.load(open(os.path.join(FIXTURE_DIR, "expected-findings.json")))
    grep_required = [e for e in expected["expected"] if e["must_be_found_by"] == "grep-scanner"]

    files = [e["file"] for e in grep_required]
    findings, _ = scan_project(
        project_dir=FIXTURE_DIR,
        source_files=files,
        stack="typescript",
        file_to_layer={f: "services" for f in files},
    )

    by_pair = {(f["rule"], f["file"]) for f in findings}
    missing = [(e["rule"], e["file"]) for e in grep_required if (e["rule"], e["file"]) not in by_pair]
    assert not missing, f"Recall failure: grep scanner missed expected findings: {missing}"
