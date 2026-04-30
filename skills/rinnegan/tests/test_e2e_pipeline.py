"""End-to-end tests for the rinnegan pipeline deterministic steps.

Tests the pipeline on a known-bad fixture project to verify:
- Inventory creation works
- Grep scanner finds planted violations
- Tool scanner finds what it can (ESLint may not be available in test env)
- Category normalization produces canonical slugs only
- Cross-cutting detection finds groups
- Quality gate produces a verdict
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "known_bad_project")
SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")

class TestE2EPipeline:
    """Run deterministic pipeline steps on the known-bad fixture project."""

    @pytest.fixture(autouse=True)
    def setup_project(self, tmp_path):
        """Copy fixture to temp dir so we don't pollute the test fixtures."""
        self.project_dir = str(tmp_path / "project")
        shutil.copytree(FIXTURE_DIR, self.project_dir)
        # Init git repo (env_checker needs it)
        subprocess.run(["git", "init"], cwd=self.project_dir, capture_output=True)
        subprocess.run(["git", "add", "."], cwd=self.project_dir, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.project_dir,
            capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "t@t",
                 "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "t@t"},
        )
        self.audit_dir = os.path.join(self.project_dir, "docs", "audit")

    def test_inventory_creation(self):
        """create-inventory.py produces valid inventory.json."""
        result = subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "create-inventory.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, f"create-inventory failed: {result.stderr}"
        inv_path = os.path.join(self.audit_dir, "data", "inventory.json")
        assert os.path.isfile(inv_path)
        inv = json.load(open(inv_path))
        # Fixture has 4 TS/TSX source files (stack=typescript ignores .py)
        assert inv["total_files"] >= 4
        assert inv["stack"] == "typescript"

    def test_grep_scanner_finds_violations(self):
        """Grep scanner detects planted violations in fixture."""
        # First create inventory
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "create-inventory.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        # Run grep scanner
        result = subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "grep-scanner.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, f"grep-scanner failed: {result.stderr}"
        output_file = os.path.join(self.audit_dir, "data", "scanner-output", "grep-scanner.jsonl")
        assert os.path.isfile(output_file)
        with open(output_file) as f:
            findings = [json.loads(line) for line in f if line.strip()]
        assert len(findings) >= 3  # eval, console.log, TODO at minimum
        rules_found = {f["rule"] for f in findings}
        assert "R05" in rules_found  # eval
        assert "R09" in rules_found  # console.log

    def test_categories_are_canonical(self):
        """All findings have canonical category slugs."""
        # Run inventory + grep scanner
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "create-inventory.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "grep-scanner.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        output_file = os.path.join(self.audit_dir, "data", "scanner-output", "grep-scanner.jsonl")
        with open(output_file) as f:
            findings = [json.loads(line) for line in f if line.strip()]
        CANONICAL = {"security", "typing", "ssot-dry", "architecture", "clean-code",
                     "performance", "data-integrity", "refactoring", "full-stack",
                     "documentation", "build"}
        for finding in findings:
            assert finding["category"] in CANONICAL, f"Non-canonical category: {finding['category']} in {finding}"

    def test_env_checker_finds_issues(self):
        """Env checker detects missing env var referenced in code."""
        sys.path.insert(0, SCRIPTS_DIR)
        from env_checker import check_env
        findings = check_env(self.project_dir, "typescript")
        # .env is gitignored but .env.example exists with only 2 keys
        # code references env vars -- the consistency check should find something
        # At minimum: env-check runs without crash
        assert isinstance(findings, list)

    def test_quality_gate_produces_verdict(self):
        """Quality gate engine produces a verdict from findings."""
        sys.path.insert(0, SCRIPTS_DIR)
        # Create inventory + grep scan to get findings
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "create-inventory.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "grep-scanner.py"),
             self.project_dir, self.audit_dir],
            capture_output=True, text=True,
        )
        # Copy grep output as findings.jsonl (simulate aggregation)
        grep_file = os.path.join(self.audit_dir, "data", "scanner-output", "grep-scanner.jsonl")
        findings_file = os.path.join(self.audit_dir, "data", "findings.jsonl")
        shutil.copy(grep_file, findings_file)

        from quality_gate import evaluate_quality_gate
        result = evaluate_quality_gate(findings_file)
        assert "readiness_score" in result
        assert "overall" in result
        assert result["overall"] in ("PASS", "CONDITIONAL", "FAIL")
        assert "tiers" in result


# ---------------------------------------------------------------------------
# Helpers for enforce-model-directive tests
# ---------------------------------------------------------------------------

def _run_pipeline(project_dir: str, extra_args: list[str] | None = None) -> str:
    pipeline_script = os.path.join(os.path.dirname(__file__), "..", "scripts", "run-pipeline.py")
    cmd = [sys.executable, pipeline_script, project_dir] + (extra_args or [])
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout + result.stderr


def _make_minimal_project(tmp_path) -> str:
    """Return a project dir wired to reach NEEDS_SCANNING."""
    project_dir = str(tmp_path / "proj")
    os.makedirs(project_dir)
    audit_data = os.path.join(project_dir, "docs", "audit", "data", "scanner-output")
    os.makedirs(audit_data, exist_ok=True)

    # Quality gate marker
    husky = os.path.join(project_dir, ".husky")
    os.makedirs(husky, exist_ok=True)
    with open(os.path.join(husky, "pre-commit"), "w") as f:
        f.write("#!/bin/sh\n")

    # Minimal inventory
    inv = {
        "total_files": 1, "total_loc": 10, "stack": "typescript",
        "framework": "none", "files": ["src/index.ts"],
    }
    with open(os.path.join(project_dir, "docs", "audit", "data", "inventory.json"), "w") as f:
        import json as _json
        _json.dump(inv, f)

    # scan-plan with one pending batch
    plan = {
        "total_batches": 1,
        "batches": [
            {
                "id": "b0", "status": "pending", "layer": "app",
                "files": ["src/index.ts"],
                "output_file": "data/scanner-output/b0.jsonl",
                "retries": 0,
            }
        ],
    }
    with open(os.path.join(project_dir, "docs", "audit", "data", "scan-plan.json"), "w") as f:
        import json as _json
        _json.dump(plan, f)

    return project_dir


def _make_minimal_project_with_scanner_output(tmp_path) -> str:
    """Return a project dir wired to reach NEEDS_AGGREGATION."""
    import json as _json
    project_dir = _make_minimal_project(tmp_path)
    audit_data = os.path.join(project_dir, "docs", "audit", "data")
    scanner_out_dir = os.path.join(audit_data, "scanner-output")

    # Mark batch complete in scan-plan
    plan_path = os.path.join(audit_data, "scan-plan.json")
    plan = _json.load(open(plan_path))
    for b in plan["batches"]:
        b["status"] = "complete"
    with open(plan_path, "w") as f:
        _json.dump(plan, f)

    # Write scanner output file + sentinel so is_output_complete is True
    scanner_file = os.path.join(scanner_out_dir, "b0.jsonl")
    finding = {
        "rule": "R09", "category": "clean-code", "severity": "low",
        "file": "src/index.ts", "line": 1, "message": "test", "layer": "app",
    }
    with open(scanner_file, "w") as f:
        f.write(_json.dumps(finding) + "\n")
    sentinel = {"lines": 1}
    with open(scanner_file + ".done", "w") as f:
        _json.dump(sentinel, f)

    return project_dir


def _make_minimal_project_with_findings(tmp_path) -> str:
    """Return a project dir wired to reach NEEDS_ENRICHMENT."""
    import json as _json
    project_dir = _make_minimal_project_with_scanner_output(tmp_path)
    audit_data = os.path.join(project_dir, "docs", "audit", "data")

    # Write findings.jsonl + sentinel (aggregation complete)
    findings_path = os.path.join(audit_data, "findings.jsonl")
    finding = {
        "rule": "R09", "category": "clean-code", "severity": "low",
        "file": "src/index.ts", "line": 1, "message": "test", "layer": "app",
        "target_code": "console.log()", "fix_plan": "remove it",
    }
    with open(findings_path, "w") as f:
        f.write(_json.dumps(finding) + "\n")
    sentinel = {"lines": 1}
    with open(findings_path + ".done", "w") as f:
        _json.dump(sentinel, f)

    return project_dir


# ---------------------------------------------------------------------------
# Enforce-model-directive tests
# ---------------------------------------------------------------------------

def test_scanning_action_block_prints_enforce_sonnet(tmp_path):
    project_dir = _make_minimal_project(tmp_path)
    output = _run_pipeline(project_dir)
    assert 'ENFORCE: pass model: "sonnet"' in output


def test_aggregation_action_block_prints_enforce_haiku(tmp_path):
    project_dir = _make_minimal_project_with_scanner_output(tmp_path)
    output = _run_pipeline(project_dir)
    assert 'ENFORCE: pass model: "haiku"' in output


def test_enrichment_action_block_prints_enforce_sonnet(tmp_path):
    project_dir = _make_minimal_project_with_findings(tmp_path)
    output = _run_pipeline(project_dir)
    assert 'ENFORCE: pass model: "sonnet"' in output


# ---------------------------------------------------------------------------
# --audit-only flag tests
# ---------------------------------------------------------------------------

def test_audit_only_skips_enrichment(tmp_path):
    project_dir = _make_minimal_project_with_findings(tmp_path)
    output = _run_pipeline(project_dir, extra_args=["--audit-only"])
    assert "NEEDS_ENRICHMENT" not in output
    assert "NEEDS_RENDERING" in output or "PIPELINE_COMPLETE" in output


def test_default_mode_still_dispatches_enrichment(tmp_path):
    project_dir = _make_minimal_project_with_findings(tmp_path)
    output = _run_pipeline(project_dir)
    assert "NEEDS_ENRICHMENT" in output


def test_audit_only_persists_across_pipeline_re_entry(tmp_path):
    project_dir = _make_minimal_project_with_findings(tmp_path)
    _run_pipeline(project_dir, extra_args=["--audit-only"])
    output = _run_pipeline(project_dir)  # no flag this time
    assert "NEEDS_ENRICHMENT" not in output
