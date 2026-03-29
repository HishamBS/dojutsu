"""Integration tests for rasengan pipeline end-to-end flow.

These tests simulate a full pipeline flow with a realistic multi-phase
project structure (2 phases, 3 tasks, inventory.json, rasengan-config.json,
and progress.md) to verify the state machine drives correctly from first
run through phase transitions to completion.
"""
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


def _run_pipeline(project_dir: str) -> tuple[str, int]:
    """Execute run_pipeline and return (output, exit_code)."""
    buf = io.StringIO()
    exit_code = run_pipeline(project_dir, out=buf)
    return buf.getvalue(), exit_code


def _read_state(project_dir: str) -> dict:
    """Read rasengan-state.json from the project audit dir."""
    state_path = os.path.join(
        project_dir, "docs", "audit", "data", "rasengan-state.json"
    )
    with open(state_path) as f:
        return json.load(f)


def _read_progress(project_dir: str) -> str:
    """Read progress.md content from the project audit dir."""
    progress_path = os.path.join(
        project_dir, "docs", "audit", "progress.md"
    )
    with open(progress_path) as f:
        return f.read()


def _make_task(
    task_id: str,
    file: str,
    line: int,
    status: str = "pending",
    resolution: str | None = None,
    rule: str = "R14",
    severity: str = "HIGH",
) -> dict:
    """Create a minimal task dict with required fields."""
    task: dict = {
        "id": task_id,
        "file": file,
        "line": line,
        "rule": rule,
        "severity": severity,
        "status": status,
        "search_pattern": f"pattern_{task_id}",
        "target_code": f"fix_{task_id}",
        "fix_plan": None,
        "explanation": f"Fix for {task_id}.",
    }
    if resolution is not None:
        task["resolution"] = resolution
    return task


@pytest.fixture()
def mini_project() -> str:
    """Create a full project structure with 2 phases, 3 tasks.

    Phase 0: 2 tasks -- BLD-001 (completed/applied), BLD-002 (pending)
    Phase 1: 1 task  -- SEC-001 (pending)

    Includes inventory.json (typescript stack), rasengan-config.json,
    and a stale progress.md to verify auto-update behavior.
    """
    with tempfile.TemporaryDirectory() as tmp:
        project_dir = os.path.join(tmp, "project")
        audit_dir = os.path.join(project_dir, "docs", "audit")
        data_dir = os.path.join(audit_dir, "data")
        tasks_dir = os.path.join(data_dir, "tasks")
        os.makedirs(tasks_dir, exist_ok=True)

        # Phase 0: 1 done + 1 pending
        phase_0 = {
            "phase": 0,
            "phase_name": "build-hygiene",
            "tasks": [
                _make_task(
                    "BLD-001", "src/app.ts", 50,
                    status="completed", resolution="applied",
                ),
                _make_task("BLD-002", "src/utils.ts", 30),
            ],
        }
        with open(os.path.join(tasks_dir, "phase-0-tasks.json"), "w") as f:
            json.dump(phase_0, f)

        # Phase 1: 1 pending
        phase_1 = {
            "phase": 1,
            "phase_name": "security-fixes",
            "tasks": [
                _make_task("SEC-001", "src/auth.ts", 15, rule="R05", severity="CRITICAL"),
            ],
        }
        with open(os.path.join(tasks_dir, "phase-1-tasks.json"), "w") as f:
            json.dump(phase_1, f)

        # inventory.json -- typescript stack
        inventory = {
            "stack": "typescript",
            "files": ["src/app.ts", "src/utils.ts", "src/auth.ts"],
            "total_files": 3,
            "total_loc": 450,
        }
        with open(os.path.join(data_dir, "inventory.json"), "w") as f:
            json.dump(inventory, f)

        # rasengan-config.json
        config = {
            "project_dir": project_dir,
            "audit_dir": audit_dir,
            "stack": "typescript",
        }
        with open(os.path.join(data_dir, "rasengan-config.json"), "w") as f:
            json.dump(config, f)

        # Stale progress.md
        with open(os.path.join(audit_dir, "progress.md"), "w") as f:
            f.write("# Old stale progress\n")

        yield project_dir


class TestIntegrationFirstRun:
    """Test 1: First run outputs the first pending task."""

    def test_first_run_outputs_pending_task(self, mini_project: str) -> None:
        """Pipeline outputs BLD-002 (first pending in phase 0) and shows PHASE: 0."""
        output, code = _run_pipeline(mini_project)

        assert code == 0, f"Pipeline exited with code {code}: {output}"
        assert "BLD-002" in output, "Expected first pending task BLD-002 in output"
        assert "PHASE: 0" in output, "Expected PHASE: 0 in output"
        # BLD-001 is completed, so it should NOT appear as NEXT_TASK
        assert "NEXT_TASK" in output
        # Verify it references the correct file
        assert "src/utils.ts" in output


class TestIntegrationStateReflectsCompleted:
    """Test 2: State file reflects actual task counts after run."""

    def test_state_reflects_completed_task(self, mini_project: str) -> None:
        """After run, rasengan-state.json has tasks_resolved=1, total_tasks=3."""
        _run_pipeline(mini_project)
        state = _read_state(mini_project)

        assert state["tasks_resolved"] == 1, (
            f"Expected 1 resolved task (BLD-001), got {state['tasks_resolved']}"
        )
        assert state["total_tasks"] == 3, (
            f"Expected 3 total tasks, got {state['total_tasks']}"
        )
        assert state["status"] == "in_progress"
        assert state["current_phase"] == 0
        assert state["current_task_id"] == "BLD-002"


class TestIntegrationProgressUpdated:
    """Test 3: progress.md is updated with correct phase statuses."""

    def test_progress_updated(self, mini_project: str) -> None:
        """After run, progress.md shows IN PROGRESS for phase with mixed statuses."""
        _run_pipeline(mini_project)
        content = _read_progress(mini_project)

        # Phase 0 has 1 done + 1 pending = IN PROGRESS
        assert "IN PROGRESS" in content, (
            "Phase 0 should show IN PROGRESS (1 done, 1 pending)"
        )
        # Phase 1 has all pending = NOT STARTED
        assert "NOT STARTED" in content, (
            "Phase 1 should show NOT STARTED (all pending)"
        )
        # Stale content should be gone
        assert "Old stale progress" not in content
        # Proper table structure
        assert "Phase" in content
        assert "Status" in content


class TestIntegrationAllComplete:
    """Test 4: ALL_PHASES_COMPLETE when every task is done."""

    def test_all_complete(self) -> None:
        """Mark all tasks completed. Run. Assert ALL_PHASES_COMPLETE, Resolved: 3."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            data_dir = os.path.join(audit_dir, "data")
            tasks_dir = os.path.join(data_dir, "tasks")
            os.makedirs(tasks_dir, exist_ok=True)

            # All 3 tasks completed
            phase_0 = {
                "phase": 0,
                "phase_name": "build-hygiene",
                "tasks": [
                    _make_task(
                        "BLD-001", "src/app.ts", 50,
                        status="completed", resolution="applied",
                    ),
                    _make_task(
                        "BLD-002", "src/utils.ts", 30,
                        status="completed", resolution="applied",
                    ),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-0-tasks.json"), "w") as f:
                json.dump(phase_0, f)

            phase_1 = {
                "phase": 1,
                "phase_name": "security-fixes",
                "tasks": [
                    _make_task(
                        "SEC-001", "src/auth.ts", 15,
                        status="completed", resolution="applied",
                        rule="R05", severity="CRITICAL",
                    ),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-1-tasks.json"), "w") as f:
                json.dump(phase_1, f)

            inventory = {"stack": "typescript", "files": [], "total_files": 3, "total_loc": 450}
            with open(os.path.join(data_dir, "inventory.json"), "w") as f:
                json.dump(inventory, f)

            output, code = _run_pipeline(project_dir)

            assert code == 0
            assert "ALL_PHASES_COMPLETE" in output
            assert "Resolved: 3" in output
            assert "Total: 3" in output

            state = _read_state(project_dir)
            assert state["status"] == "completed"
            assert state["tasks_resolved"] == 3
            assert sorted(state["phases_completed"]) == [0, 1]


class TestIntegrationBuildVerifyInAction:
    """Test 5: Build verify command appears in ACTION for typescript stack."""

    def test_build_verify_in_action(self, mini_project: str) -> None:
        """ACTION output must include 'tsc --noEmit' for typescript stack."""
        output, code = _run_pipeline(mini_project)

        assert code == 0
        assert "tsc --noEmit" in output, (
            "Expected 'tsc --noEmit' in ACTION output for typescript project"
        )


class TestIntegrationCompletedAtInAction:
    """Test 6: ACTION output instructs setting completed_at."""

    def test_completed_at_in_action(self, mini_project: str) -> None:
        """ACTION output must mention completed_at for pending tasks."""
        output, code = _run_pipeline(mini_project)

        assert code == 0
        assert "completed_at" in output, (
            "ACTION must instruct LLM to set completed_at timestamp"
        )


class TestIntegrationPhaseTransitions:
    """Test 7: Pipeline transitions to next phase when current is complete."""

    def test_phase_transitions(self) -> None:
        """Phase 0 all done, phase 1 pending. Run. Assert PHASE: 1."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            data_dir = os.path.join(audit_dir, "data")
            tasks_dir = os.path.join(data_dir, "tasks")
            os.makedirs(tasks_dir, exist_ok=True)

            # Phase 0: fully complete
            phase_0 = {
                "phase": 0,
                "phase_name": "build-hygiene",
                "tasks": [
                    _make_task(
                        "BLD-001", "src/app.ts", 50,
                        status="completed", resolution="applied",
                    ),
                    _make_task(
                        "BLD-002", "src/utils.ts", 30,
                        status="completed", resolution="applied",
                    ),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-0-tasks.json"), "w") as f:
                json.dump(phase_0, f)

            # Phase 1: still pending
            phase_1 = {
                "phase": 1,
                "phase_name": "security-fixes",
                "tasks": [
                    _make_task("SEC-001", "src/auth.ts", 15, rule="R05", severity="CRITICAL"),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-1-tasks.json"), "w") as f:
                json.dump(phase_1, f)

            inventory = {"stack": "typescript", "files": [], "total_files": 3, "total_loc": 450}
            with open(os.path.join(data_dir, "inventory.json"), "w") as f:
                json.dump(inventory, f)

            output, code = _run_pipeline(project_dir)

            assert code == 0
            assert "PHASE: 1" in output, (
                "Pipeline should transition to phase 1 when phase 0 is complete"
            )
            assert "SEC-001" in output, "Next task should be SEC-001 from phase 1"
            assert "ALL_PHASES_COMPLETE" not in output

            state = _read_state(project_dir)
            assert state["current_phase"] == 1
            assert 0 in state["phases_completed"]
            assert 1 not in state["phases_completed"]
            assert state["current_task_id"] == "SEC-001"


class TestIntegrationReorderDetection:
    """Test 8: Reorder detection for same-file tasks in wrong order."""

    def test_reorder_detection(self) -> None:
        """Same-file tasks in ascending line order triggers REORDER_NEEDED."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            data_dir = os.path.join(audit_dir, "data")
            tasks_dir = os.path.join(data_dir, "tasks")
            os.makedirs(tasks_dir, exist_ok=True)

            # Two pending tasks in the same file with ascending lines (wrong order).
            # The pipeline expects descending line order for same-file tasks
            # so fixes apply bottom-up without shifting earlier line numbers.
            phase_0 = {
                "phase": 0,
                "phase_name": "build-hygiene",
                "tasks": [
                    _make_task("BLD-001", "src/app.ts", 10),
                    _make_task("BLD-002", "src/app.ts", 50),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-0-tasks.json"), "w") as f:
                json.dump(phase_0, f)

            inventory = {"stack": "typescript", "files": [], "total_files": 1, "total_loc": 100}
            with open(os.path.join(data_dir, "inventory.json"), "w") as f:
                json.dump(inventory, f)

            output, code = _run_pipeline(project_dir)

            assert code == 0
            assert "REORDER_NEEDED" in output, (
                "Ascending line order for same-file tasks should trigger REORDER_NEEDED"
            )
            assert "src/app.ts" in output
            # When reorder is needed, the pipeline should NOT output a NEXT_TASK
            assert "NEXT_TASK" not in output

    def test_no_reorder_when_descending(self) -> None:
        """Same-file tasks in descending line order should NOT trigger REORDER_NEEDED."""
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = os.path.join(tmp, "project")
            audit_dir = os.path.join(project_dir, "docs", "audit")
            data_dir = os.path.join(audit_dir, "data")
            tasks_dir = os.path.join(data_dir, "tasks")
            os.makedirs(tasks_dir, exist_ok=True)

            # Correct order: descending lines for same file
            phase_0 = {
                "phase": 0,
                "phase_name": "build-hygiene",
                "tasks": [
                    _make_task("BLD-001", "src/app.ts", 50),
                    _make_task("BLD-002", "src/app.ts", 10),
                ],
            }
            with open(os.path.join(tasks_dir, "phase-0-tasks.json"), "w") as f:
                json.dump(phase_0, f)

            inventory = {"stack": "typescript", "files": [], "total_files": 1, "total_loc": 100}
            with open(os.path.join(data_dir, "inventory.json"), "w") as f:
                json.dump(inventory, f)

            output, code = _run_pipeline(project_dir)

            assert code == 0
            assert "REORDER_NEEDED" not in output
            assert "NEXT_TASK" in output
