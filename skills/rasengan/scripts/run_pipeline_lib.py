"""Rasengan pipeline state machine -- importable library.

All core logic extracted from run-pipeline.py so that pytest-cov can
measure coverage when tests import and call functions directly.
"""
import json
import os
import glob
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import TextIO

# Token budget tracking (graceful fallback if dojutsu not installed)
import sys as _sys
_dojutsu_scripts = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'dojutsu', 'scripts')
if os.path.isdir(_dojutsu_scripts):
    _sys.path.insert(0, os.path.realpath(_dojutsu_scripts))
try:
    from dojutsu_state import log_dispatch
except ImportError:
    def log_dispatch(*a, **kw): pass


BUILD_COMMANDS: dict[str, str] = {
    "typescript": "npx tsc --noEmit",
    "python": "python3 -m py_compile",
    "java": "mvn compile -q",
}


def update_progress_md(
    audit_dir: str,
    all_phases_data: list[tuple[str, dict]],
    now_iso: str,
) -> None:
    """Regenerate progress.md from actual task data.

    Determines per-phase status from task statuses:
    - COMPLETE: all tasks have a non-pending status (completed/skipped)
    - IN PROGRESS: at least one task done and at least one pending
    - NOT STARTED: all tasks still pending
    - EMPTY: phase has zero tasks
    """
    lines: list[str] = []
    total_findings = sum(len(d["tasks"]) for _, d in all_phases_data)

    lines.append("# Audit Remediation Progress")
    lines.append("")
    lines.append(
        f"> **Updated:** {now_iso} | **Total Findings:** {total_findings}"
    )
    lines.append("")
    lines.append("## Phase Status")
    lines.append("")
    lines.append(
        "| Phase | Name | Findings | Completed | Status |"
    )
    lines.append(
        "|-------|------|----------|-----------|--------|"
    )

    for _filepath, data in all_phases_data:
        phase_num = data.get("phase", "?")
        phase_name = data.get("phase_name", f"phase-{phase_num}")
        tasks = data.get("tasks", [])
        task_count = len(tasks)

        if task_count == 0:
            status = "EMPTY"
            done_count = 0
        else:
            done_count = sum(
                1
                for t in tasks
                if t.get("status") != "pending"
            )
            if done_count == 0:
                status = "NOT STARTED"
            elif done_count == task_count:
                status = "COMPLETE"
            else:
                status = "IN PROGRESS"

        lines.append(
            f"| {phase_num} | {phase_name} | {task_count} | {done_count} | {status} |"
        )

    lines.append("")

    progress_path = os.path.join(audit_dir, "progress.md")
    with open(progress_path, "w") as f:
        f.write("\n".join(lines))


def scan_all_phases(
    task_files: list[str],
) -> tuple[
    list[tuple[str, dict]],  # all_phases_data
    int,   # total_tasks
    int,   # tasks_resolved
    int,   # tasks_skipped
    int,   # tasks_failed
    list,  # phases_completed
    str | None,   # current_phase_file
    int | None,   # current_phase_num
    dict | None,  # phase_data
]:
    """Scan all task files and compute counts, find first pending phase."""
    all_phases_data: list[tuple[str, dict]] = []
    total_tasks = 0
    tasks_resolved = 0
    tasks_skipped = 0
    tasks_failed = 0
    phases_completed: list = []
    current_phase_file: str | None = None
    current_phase_num: int | None = None
    phase_data: dict | None = None

    for tf in task_files:
        with open(tf) as f:
            data = json.load(f)
        phase_num = data.get("phase", "?")
        tasks_in_phase = data["tasks"]
        all_phases_data.append((tf, data))

        phase_pending = 0
        for t in tasks_in_phase:
            total_tasks += 1
            status = t.get("status", "pending")
            resolution = t.get("resolution")
            if status == "completed" and resolution in (
                "applied", "already_resolved", "line-shifted",
            ):
                tasks_resolved += 1
            elif status == "skipped" or resolution == "skipped":
                tasks_skipped += 1
            elif resolution == "failed":
                tasks_failed += 1
            if status == "pending":
                phase_pending += 1

        if phase_pending == 0:
            if phase_num not in phases_completed:
                phases_completed.append(phase_num)
        elif current_phase_file is None:
            current_phase_file = tf
            current_phase_num = phase_num
            phase_data = data

    return (
        all_phases_data,
        total_tasks,
        tasks_resolved,
        tasks_skipped,
        tasks_failed,
        phases_completed,
        current_phase_file,
        current_phase_num,
        phase_data,
    )


def load_or_create_state(
    state_file: str,
    now_iso: str,
) -> dict:
    """Load existing state or create a new one."""
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)
        state["session_count"] = state.get("session_count", 0) + 1
    else:
        state = {
            "started_at": now_iso,
            "session_count": 1,
        }
    return state


def detect_stack(audit_dir: str) -> tuple[str, str | None]:
    """Read inventory.json and return (stack, build_command)."""
    inventory_path = os.path.join(audit_dir, "data", "inventory.json")
    stack = "unknown"
    if os.path.exists(inventory_path):
        with open(inventory_path) as f:
            inv = json.load(f)
        stack = inv.get("stack", "unknown")
    build_command = BUILD_COMMANDS.get(stack)
    return stack, build_command


def format_action_output(
    next_task: dict,
    task_index: int,
    phase_file_basename: str,
    build_command: str | None,
) -> str:
    """Format the ACTION output block for a single pending task."""
    lines: list[str] = []
    has_tc = next_task.get("target_code") is not None
    has_fp = bool(next_task.get("fix_plan"))

    lines.append(f"\nNEXT_TASK: index={task_index} id={next_task['id']}")
    lines.append(f"  File: {next_task['file']}:{next_task['line']}")
    lines.append(
        f"  Rule: {next_task.get('rule', '?')} | "
        f"Severity: {next_task.get('severity', '?')}"
    )
    lines.append(
        f"  search_pattern: {next_task.get('search_pattern', 'none')}"
    )
    lines.append(f"  Has target_code: {has_tc}")
    lines.append(f"  Has fix_plan: {has_fp}")

    lines.append(f"\nACTION: Fix this violation.")
    lines.append(f"  MODEL: sonnet")
    lines.append(f"  ROLE: dojutsu-fixer (if agent-mux configured)")
    lines.append(f"  1. Read file: {next_task['file']}")
    lines.append(
        f"  2. Find pattern '{next_task.get('search_pattern', '')}' "
        f"near line {next_task['line']}"
    )
    if has_tc:
        lines.append(f"  3. Apply: Edit tool, replace with target_code")
        lines.append(
            f"     TARGET: {str(next_task['target_code'])[:200]}"
        )
    elif has_fp:
        lines.append(
            f"  3. Execute fix_plan ({len(next_task['fix_plan'])} steps):"
        )
        for step in next_task["fix_plan"]:
            lines.append(
                f"     Step {step['step']}: {step['action']} "
                f"{step.get('file', '')} -- {step.get('description', '')}"
            )
    else:
        lines.append(f"  3. Read explanation and write appropriate fix")

    lines.append(f"  4. Verify fix present in file")
    lines.append(
        f"  5. Update {phase_file_basename} index {task_index}: "
        f"set status='completed', resolution='applied', "
        f"completed_at='<current ISO timestamp>'"
    )
    if build_command:
        lines.append(
            f"  6. Verify build: run `{build_command}` "
            f"and fix any errors before proceeding"
        )
    else:
        lines.append(
            f"  6. Verify build: run the project build command "
            f"and fix any errors before proceeding"
        )
    lines.append(f"  7. Run this script again for next task")

    lines.append(
        f"\n  EXPLANATION: {next_task.get('explanation', 'none')[:300]}"
    )
    return "\n".join(lines)


def run_pipeline(project_dir: str, out: TextIO | None = None) -> int:
    """Main pipeline entry point.

    Args:
        project_dir: Path to the project directory.
        out: Output stream (defaults to sys.stdout).

    Returns:
        Exit code (0 = success, 1 = error).
    """
    if out is None:
        out = sys.stdout

    audit_dir = os.path.join(project_dir, "docs", "audit")
    skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    task_files = sorted(
        glob.glob(
            os.path.join(audit_dir, "data/tasks/phase-*-tasks.json")
        )
    )

    if not task_files:
        out.write("ERROR: No task files found. Run /rinnegan first.\n")
        out.write(f"Expected: {audit_dir}/data/tasks/phase-*-tasks.json\n")
        return 1

    _stack, build_command = detect_stack(audit_dir)

    (
        all_phases_data,
        total_tasks,
        tasks_resolved,
        tasks_skipped,
        tasks_failed,
        phases_completed,
        current_phase_file,
        current_phase_num,
        phase_data,
    ) = scan_all_phases(task_files)

    # --- Load or create state ---
    now_iso = datetime.now(timezone.utc).isoformat()
    state_file = os.path.join(audit_dir, "data", "rasengan-state.json")
    state = load_or_create_state(state_file, now_iso)

    # Determine current_task_id
    next_task_id = None
    if phase_data is not None:
        pending_tasks = [
            t for t in phase_data["tasks"] if t["status"] == "pending"
        ]
        if pending_tasks:
            next_task_id = pending_tasks[0].get("id")

    # Sync state from actual task data on every run
    state["last_updated"] = now_iso
    state["current_phase"] = current_phase_num
    state["current_task_id"] = next_task_id
    state["phases_completed"] = sorted(
        p for p in phases_completed if isinstance(p, int)
    )
    state["total_tasks"] = total_tasks
    state["tasks_resolved"] = tasks_resolved
    state["tasks_skipped"] = tasks_skipped
    state["tasks_failed"] = tasks_failed

    # Set status based on whether all phases are complete
    if current_phase_file is None:
        state["status"] = "completed"
    else:
        state["status"] = "in_progress"

    # Ensure started_at is always present
    if "started_at" not in state:
        state["started_at"] = now_iso

    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)

    # --- Update progress.md from actual task data ---
    update_progress_md(audit_dir, all_phases_data, now_iso)

    out.write(f"AUDIT_DIR: {audit_dir}\n")
    out.write(f"SKILL_DIR: {skill_dir}\n")
    out.write(f"PROJECT_DIR: {project_dir}\n")

    # All phases complete
    if current_phase_file is None:
        out.write(f"\nALL_PHASES_COMPLETE\n")
        out.write(
            f"  Total: {state['total_tasks']}, "
            f"Resolved: {state['tasks_resolved']}\n"
        )
        out.write(
            f"  Skipped: {state['tasks_skipped']}, "
            f"Failed: {state['tasks_failed']}\n"
        )
        out.write(f"\nACTION: Final verification and report.\n")
        out.write(
            f"  Run: {skill_dir}/verify-phase.sh on each completed phase\n"
        )
        out.write(
            f"  Read: {skill_dir}/report-generator-prompt.md "
            f"for report structure\n"
        )
        out.write(
            f"  Write: {audit_dir}/data/rasengan-results.json\n"
        )
        return 0

    # Current phase info
    assert phase_data is not None
    tasks = phase_data["tasks"]
    all_pending = [t for t in tasks if t["status"] == "pending"]
    completed = [t for t in tasks if t["status"] == "completed"]
    failed = [t for t in tasks if t.get("resolution") == "failed"]

    # Split by confidence: HIGH+MEDIUM = auto-fix, LOW = human review
    auto_fix_pending = [t for t in all_pending
                        if t.get("confidence", "high") in ("high", "medium")]
    low_pending = [t for t in all_pending
                   if t.get("confidence") == "low"]

    # Load human decisions for LOW findings
    decisions_path = os.path.join(audit_dir, "data", "human-decisions.json")
    human_decisions: dict = {}
    if os.path.exists(decisions_path):
        with open(decisions_path) as df:
            human_decisions = json.load(df)

    # Apply existing bulk decisions to LOW findings
    bulk_rules = human_decisions.get("bulk_rules", {})
    decided_ids = human_decisions.get("decided_ids", {})
    for t in low_pending:
        tid = t.get("id", "")
        rule = t.get("rule", "")
        if tid in decided_ids:
            action = decided_ids[tid]
            if action == "skip":
                t["status"] = "completed"
                t["resolution"] = "skipped"
                t["notes"] = "Skipped by human decision"
            # "fix" decisions stay pending — will be picked up below
        elif rule in bulk_rules:
            action = bulk_rules[rule]
            if action in ("skip", "skip-all-low"):
                t["status"] = "completed"
                t["resolution"] = "skipped"
                t["notes"] = f"Skipped by bulk decision: skip-all-{rule}-LOW"
            elif action in ("fix", "fix-all-low"):
                auto_fix_pending.append(t)  # promote to auto-fix

    # Save any bulk-decision skips
    if any(t["status"] == "completed" and t.get("notes", "").startswith("Skipped by")
           for t in low_pending):
        with open(current_phase_file, "w") as pf:
            json.dump(phase_data, pf, indent=2)

    # Recalculate after applying decisions
    still_undecided_low = [t for t in all_pending
                           if t.get("confidence") == "low"
                           and t["status"] == "pending"
                           and t.get("id", "") not in decided_ids
                           and t.get("rule", "") not in bulk_rules]

    # If no auto-fix tasks remain but undecided LOW exist → human review
    if not auto_fix_pending and still_undecided_low:
        out.write(f"\n{'='*60}\n")
        out.write(f"LOW-CONFIDENCE REVIEW: {len(still_undecided_low)} findings need your input\n")
        out.write(f"{'='*60}\n\n")
        for i, t in enumerate(still_undecided_low[:15]):
            out.write(f"[{i+1}/{len(still_undecided_low)}] {t.get('id','?')} [{t.get('rule','')}] {t['file']}:{t['line']}\n")
            out.write(f"  {t.get('description', '')}\n")
            out.write(f"  Confidence: LOW — {t.get('confidence_reason', 'no reason given')}\n")
            if t.get("target_code"):
                out.write(f"  Fix: {str(t['target_code'])[:120]}\n")
            out.write("\n")
        if len(still_undecided_low) > 15:
            out.write(f"  ... and {len(still_undecided_low) - 15} more\n\n")
        out.write(f"ACTION: Review LOW-confidence findings and record decisions.\n")
        out.write(f"  Write to: {decisions_path}\n")
        out.write(f'  Format: {{"decided_ids": {{"FINDING-ID": "fix|skip"}}, "bulk_rules": {{"R04": "skip-all-low"}}}}\n')
        out.write(f"  Then run this script again to apply decisions and continue.\n")
        return 0

    # Use auto-fix list as the pending list for task selection
    pending = auto_fix_pending

    out.write(
        f"\nPHASE: {current_phase_num} "
        f"({phase_data.get('phase_name', 'unknown')})\n"
    )
    out.write(
        f"  Total: {len(tasks)}, Pending: {len(pending)}, "
        f"Done: {len(completed)}, Failed: {len(failed)}\n"
    )
    out.write(f"  File: {current_phase_file}\n")

    if len(pending) > 50:
        out.write(
            f"\n  WARNING: {len(pending)} tasks. "
            f"Process first 30, then commit and pause.\n"
        )

    # Check task ordering
    by_file: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for i, t in enumerate(tasks):
        if t["status"] == "pending":
            by_file[t["file"]].append((i, t["line"]))
    reorder_needed = False
    for file_key, file_tasks in by_file.items():
        file_lines = [t[1] for t in file_tasks]
        if file_lines != sorted(file_lines, reverse=True):
            out.write(f"  REORDER_NEEDED: {file_key}\n")
            reorder_needed = True

    if reorder_needed:
        out.write(
            f"\nACTION: Reorder tasks in {current_phase_file} so "
            f"same-file tasks have descending line numbers. "
            f"Then run this script again.\n"
        )
        return 0

    # Output next task
    next_task = pending[0]
    task_index = tasks.index(next_task)

    log_dispatch(project_dir, task=f"fix_{next_task.get('id', '?')}", tokens=5000, model="sonnet")

    action_output = format_action_output(
        next_task,
        task_index,
        os.path.basename(current_phase_file),
        build_command,
    )
    out.write(action_output)
    out.write("\n")

    return 0
