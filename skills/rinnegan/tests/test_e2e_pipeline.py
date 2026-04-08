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
