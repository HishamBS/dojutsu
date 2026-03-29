"""Tests for rasengan run-pipeline state machine."""
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure the scripts package is importable
_scripts_dir = str(Path(__file__).resolve().parent.parent / "scripts")
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from run_pipeline_lib import run_pipeline  # noqa: E402

BUILD_COMMANDS = {
    "typescript": "npx tsc --noEmit",
    "python": "python3 -m py_compile",
    "java": "mvn compile -q",
}

REQUIRED_STATE_FIELDS = [
    "started_at",
    "last_updated",
    "current_phase",
    "current_task_id",
    "phases_completed",
    "total_tasks",
    "tasks_resolved",
    "tasks_skipped",
    "tasks_failed",
    "session_count",
    "status",
]


def _make_project(
    tmp: str,
    tasks_by_phase: dict[int, list[dict]] | None = None,
    stack: str = "typescript",
    rasengan_config: dict | None = None,
    existing_state: dict | None = None,
) -> str:
    """Create a minimal project directory with audit data for testing.

    Args:
        tmp: Base temp directory.
        tasks_by_phase: Mapping of phase number to list of task dicts.
            If None, creates a single phase-0 with one pending task.
        stack: Stack name for inventory.json.
        rasengan_config: Optional rasengan-config.json content.
        existing_state: Optional pre-existing rasengan-state.json content.

    Returns:
        Path to the project directory.
    """
    project_dir = os.path.join(tmp, "project")
    audit_dir = os.path.join(project_dir, "docs", "audit")
    tasks_dir = os.path.join(audit_dir, "data", "tasks")
    os.makedirs(tasks_dir, exist_ok=True)

    if tasks_by_phase is None:
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "src/app.ts",
                    "line": 10,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "pending",
                    "search_pattern": "console.log",
                    "target_code": "logger.info(msg)",
                    "fix_plan": None,
                    "explanation": "Use structured logging.",
                }
            ],
        }

    for phase_num, tasks in tasks_by_phase.items():
        phase_file = os.path.join(tasks_dir, f"phase-{phase_num}-tasks.json")
        with open(phase_file, "w") as f:
            json.dump(
                {
                    "phase": phase_num,
                    "phase_name": f"phase-{phase_num}",
                    "tasks": tasks,
                },
                f,
            )

    inventory = {"stack": stack, "files": [], "total_files": 0, "total_loc": 0}
    with open(os.path.join(audit_dir, "data", "inventory.json"), "w") as f:
        json.dump(inventory, f)

    if rasengan_config is not None:
        with open(os.path.join(audit_dir, "data", "rasengan-config.json"), "w") as f:
            json.dump(rasengan_config, f)

    if existing_state is not None:
        with open(os.path.join(audit_dir, "data", "rasengan-state.json"), "w") as f:
            json.dump(existing_state, f)

    return project_dir


def _run_pipeline(project_dir: str) -> tuple[str, int]:
    """Execute run_pipeline and return (output, exit_code)."""
    buf = io.StringIO()
    exit_code = run_pipeline(project_dir, out=buf)
    return buf.getvalue(), exit_code


def _read_state(project_dir: str) -> dict:
    """Read the rasengan-state.json from the project's audit dir."""
    state_path = os.path.join(
        project_dir, "docs", "audit", "data", "rasengan-state.json"
    )
    with open(state_path) as f:
        return json.load(f)


class TestBuildVerifyInAction:
    """Tests for Finding #1/#2: build verification step in ACTION output."""

    def test_action_includes_build_verify_typescript(self) -> None:
        """ACTION output must include tsc --noEmit for typescript projects."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="typescript")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "npx tsc --noEmit" in output

    def test_action_includes_build_verify_python(self) -> None:
        """ACTION output must include py_compile for python projects."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="python")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "python3 -m py_compile" in output

    def test_action_includes_build_verify_java(self) -> None:
        """ACTION output must include mvn compile for java projects."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="java")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "mvn compile -q" in output

    def test_build_verify_after_fix_step(self) -> None:
        """Build verify step must come AFTER the fix application steps."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="typescript")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            lines = output.split("\n")
            fix_step_idx = None
            build_step_idx = None
            for i, line in enumerate(lines):
                if "Update" in line and "status=" in line:
                    fix_step_idx = i
                if "npx tsc --noEmit" in line:
                    build_step_idx = i
            assert fix_step_idx is not None, "Fix step not found in output"
            assert build_step_idx is not None, "Build verify step not found in output"
            assert build_step_idx > fix_step_idx, (
                "Build verify must come after the fix/update step"
            )


class TestCompletedAtInstruction:
    """Tests for Finding #5: completed_at timestamp instruction."""

    def test_action_mentions_completed_at(self) -> None:
        """ACTION output must instruct LLM to set completed_at."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "completed_at" in output

    def test_action_mentions_iso_timestamp(self) -> None:
        """ACTION must mention ISO timestamp format for completed_at."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            output, code = _run_pipeline(project_dir)
            assert code == 0
            output_lower = output.lower()
            assert "iso" in output_lower or "timestamp" in output_lower


class TestStateFileRequiredFields:
    """Tests for state file having all 11 required fields per spec."""

    def test_state_has_required_fields(self) -> None:
        """State file must contain all 11 fields from output-templates.md."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            for field in REQUIRED_STATE_FIELDS:
                assert field in state, f"Missing required field: {field}"

    def test_state_started_at_is_iso(self) -> None:
        """started_at must be a valid ISO timestamp string."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            started = state["started_at"]
            assert isinstance(started, str)
            assert len(started) >= 19, "Timestamp too short to be ISO"
            assert "T" in started, "ISO timestamp must contain T separator"

    def test_state_last_updated_is_iso(self) -> None:
        """last_updated must be a valid ISO timestamp string."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            updated = state["last_updated"]
            assert isinstance(updated, str)
            assert len(updated) >= 19
            assert "T" in updated

    def test_state_current_task_id_set(self) -> None:
        """current_task_id must be set to the next pending task id."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert state["current_task_id"] == "BLD-001"


class TestStateSyncFromTaskData:
    """Tests for state counts matching actual task data across all phases."""

    def test_state_counts_match_task_data(self) -> None:
        """tasks_resolved must match actual completed task count."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "a.ts",
                    "line": 1,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "x",
                    "target_code": "y",
                    "fix_plan": None,
                    "explanation": "test",
                },
                {
                    "id": "BLD-002",
                    "file": "b.ts",
                    "line": 5,
                    "rule": "R14",
                    "severity": "MEDIUM",
                    "status": "completed",
                    "resolution": "already_resolved",
                    "search_pattern": "z",
                    "target_code": "w",
                    "fix_plan": None,
                    "explanation": "test",
                },
                {
                    "id": "BLD-003",
                    "file": "c.ts",
                    "line": 10,
                    "rule": "R14",
                    "severity": "LOW",
                    "status": "pending",
                    "search_pattern": "q",
                    "target_code": "r",
                    "fix_plan": None,
                    "explanation": "test",
                },
            ],
            1: [
                {
                    "id": "SEC-001",
                    "file": "d.ts",
                    "line": 1,
                    "rule": "R05",
                    "severity": "CRITICAL",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "v",
                    "target_code": "u",
                    "fix_plan": None,
                    "explanation": "test",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert state["tasks_resolved"] == 3
            assert state["total_tasks"] == 4

    def test_state_counts_skipped_and_failed(self) -> None:
        """tasks_skipped and tasks_failed must match actual counts."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "a.ts",
                    "line": 1,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "skipped",
                    "resolution": "skipped",
                    "search_pattern": "x",
                    "target_code": None,
                    "fix_plan": None,
                    "explanation": "test",
                },
                {
                    "id": "BLD-002",
                    "file": "b.ts",
                    "line": 5,
                    "rule": "R14",
                    "severity": "MEDIUM",
                    "status": "completed",
                    "resolution": "failed",
                    "search_pattern": "z",
                    "target_code": None,
                    "fix_plan": None,
                    "explanation": "test",
                },
                {
                    "id": "BLD-003",
                    "file": "c.ts",
                    "line": 10,
                    "rule": "R14",
                    "severity": "LOW",
                    "status": "pending",
                    "search_pattern": "q",
                    "target_code": "r",
                    "fix_plan": None,
                    "explanation": "test",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert state["tasks_skipped"] == 1
            assert state["tasks_failed"] == 1

    def test_state_phases_completed_synced(self) -> None:
        """phases_completed must list phases where all tasks are done."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "a.ts",
                    "line": 1,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "x",
                    "target_code": "y",
                    "fix_plan": None,
                    "explanation": "done",
                },
            ],
            1: [
                {
                    "id": "SEC-001",
                    "file": "d.ts",
                    "line": 1,
                    "rule": "R05",
                    "severity": "CRITICAL",
                    "status": "pending",
                    "search_pattern": "v",
                    "target_code": "u",
                    "fix_plan": None,
                    "explanation": "test",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert 0 in state["phases_completed"]
            assert 1 not in state["phases_completed"]

    def test_existing_state_session_count_incremented(self) -> None:
        """On resume, session_count must increment."""
        existing_state = {
            "started_at": "2026-03-16T10:00:00Z",
            "last_updated": "2026-03-16T10:00:00Z",
            "current_phase": 0,
            "current_task_id": None,
            "phases_completed": [],
            "total_tasks": 1,
            "tasks_resolved": 0,
            "tasks_skipped": 0,
            "tasks_failed": 0,
            "session_count": 2,
            "status": "in_progress",
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, existing_state=existing_state)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert state["session_count"] == 3


class TestAllPhasesComplete:
    """Tests for ALL_PHASES_COMPLETE output with correct counts."""

    def test_all_complete_output(self) -> None:
        """When all tasks are done, output ALL_PHASES_COMPLETE with correct count."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "a.ts",
                    "line": 1,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "x",
                    "target_code": "y",
                    "fix_plan": None,
                    "explanation": "done",
                },
                {
                    "id": "BLD-002",
                    "file": "b.ts",
                    "line": 5,
                    "rule": "R14",
                    "severity": "MEDIUM",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "z",
                    "target_code": "w",
                    "fix_plan": None,
                    "explanation": "done",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "ALL_PHASES_COMPLETE" in output
            assert "Resolved: 2" in output

    def test_all_complete_state_status(self) -> None:
        """State file must have status=completed when all phases done."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "a.ts",
                    "line": 1,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "search_pattern": "x",
                    "target_code": "y",
                    "fix_plan": None,
                    "explanation": "done",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            _run_pipeline(project_dir)
            state = _read_state(project_dir)
            assert state["status"] == "completed"


class TestConfigLoading:
    """Tests for rasengan-config.json loading and stack detection."""

    def test_uses_inventory_stack(self) -> None:
        """Script must read stack from inventory.json for build command."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="python")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            assert "python3 -m py_compile" in output
            assert "npx tsc" not in output

    def test_unknown_stack_no_build_command(self) -> None:
        """For unknown stacks, output a generic build verify instruction."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, stack="rust")
            output, code = _run_pipeline(project_dir)
            assert code == 0
            # Should still mention build verification even for unknown stacks
            assert "build" in output.lower() or "verify" in output.lower()


class TestProgressUpdate:
    """Finding #6: Pipeline must keep progress.md in sync with task data."""

    def test_progress_file_updated_on_run(self) -> None:
        """Completed phase shows COMPLETE in progress.md."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "src/app.ts",
                    "line": 10,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "completed_at": "2026-03-19T10:00:00Z",
                    "search_pattern": "console.log",
                    "target_code": "logger.info(msg)",
                    "fix_plan": None,
                    "explanation": "Use structured logging.",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            progress_path = os.path.join(
                project_dir, "docs", "audit", "progress.md"
            )
            # Write stale content
            with open(progress_path, "w") as f:
                f.write("# Old\n| 0 | NOT STARTED |\n")

            _run_pipeline(project_dir)
            with open(progress_path) as f:
                content = f.read()
            assert "COMPLETE" in content

    def test_progress_shows_in_progress(self) -> None:
        """Phase with mixed statuses shows IN PROGRESS."""
        tasks_by_phase = {
            0: [
                {
                    "id": "BLD-001",
                    "file": "src/app.ts",
                    "line": 10,
                    "rule": "R14",
                    "severity": "HIGH",
                    "status": "completed",
                    "resolution": "applied",
                    "completed_at": "2026-03-19T10:00:00Z",
                    "search_pattern": "console.log",
                    "target_code": "logger.info(msg)",
                    "fix_plan": None,
                    "explanation": "Use structured logging.",
                },
                {
                    "id": "BLD-002",
                    "file": "src/b.ts",
                    "line": 5,
                    "rule": "R14",
                    "severity": "LOW",
                    "status": "pending",
                    "search_pattern": "TODO",
                    "target_code": None,
                    "fix_plan": None,
                    "explanation": "Test",
                    "group": "",
                    "current_code": "// TODO",
                    "imports_needed": [],
                    "effort": "low",
                    "completed_at": None,
                    "resolution": None,
                    "actual_line": None,
                    "notes": "",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp, tasks_by_phase=tasks_by_phase)
            progress_path = os.path.join(
                project_dir, "docs", "audit", "progress.md"
            )
            with open(progress_path, "w") as f:
                f.write("# Old\n")

            _run_pipeline(project_dir)
            with open(progress_path) as f:
                content = f.read()
            assert "IN PROGRESS" in content

    def test_progress_has_table_headers(self) -> None:
        """progress.md must have proper table headers."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = _make_project(tmp)
            progress_path = os.path.join(
                project_dir, "docs", "audit", "progress.md"
            )
            with open(progress_path, "w") as f:
                f.write("")

            _run_pipeline(project_dir)
            with open(progress_path) as f:
                content = f.read()
            assert "Phase" in content
            assert "Status" in content
