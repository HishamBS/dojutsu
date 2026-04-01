#!/usr/bin/env python3
"""Revalidate pending tasks against live source code.

Deterministic. Zero tokens. Runs in <5 seconds.
Called by dojutsu (between phases, at startup) and rasengan (before each task).

Usage:
  python3 revalidate-tasks.py <project_dir>              # revalidate ALL pending tasks
  python3 revalidate-tasks.py <project_dir> --phase 5    # revalidate only phase 5
  python3 revalidate-tasks.py <project_dir> --task BLD-042  # revalidate one task
  python3 revalidate-tasks.py <project_dir> --changed-only  # only tasks in files modified since last commit
"""
from __future__ import annotations

import json
import glob
import os
import subprocess
import sys
from pathlib import Path


def get_modified_files(project_dir: str, since: str = "HEAD~1") -> set[str]:
    """Get files modified since a git ref."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", since],
            capture_output=True, text=True, cwd=project_dir,
        )
        if result.returncode == 0:
            return set(result.stdout.strip().split("\n")) if result.stdout.strip() else set()
    except Exception:
        pass
    return set()


def find_code_in_file(file_path: str, current_code: str, cited_line: int) -> tuple[str, int | None]:
    """Search for current_code in a file.

    Returns:
        (status, found_line)
        status: "exact" | "nearby" | "file_wide" | "not_found" | "file_missing"
    """
    if not os.path.exists(file_path):
        return "file_missing", None

    try:
        with open(file_path) as f:
            lines = f.readlines()
    except Exception:
        return "file_missing", None

    # Extract first meaningful line of current_code
    cc_first = current_code.strip().split("\n")[0].strip()
    if len(cc_first) < 5:
        return "exact", cited_line  # Too short to validate, trust it

    # 1. Exact line
    if 0 < cited_line <= len(lines) and cc_first in lines[cited_line - 1]:
        return "exact", cited_line

    # 2. Nearby (+/-20 lines)
    for offset in range(1, 21):
        for check in [cited_line - 1 + offset, cited_line - 1 - offset]:
            if 0 <= check < len(lines) and cc_first in lines[check]:
                return "nearby", check + 1

    # 3. Whole file
    for i, line in enumerate(lines):
        if cc_first in line:
            return "file_wide", i + 1

    return "not_found", None


def revalidate_task(task: dict, project_dir: str) -> str:
    """Revalidate a single task against live source code.

    Returns: "valid" | "line_updated" | "already_resolved" | "needs_rescan"
    """
    if task.get("status") != "pending":
        return "skipped"

    file_path = os.path.join(project_dir, task.get("file", ""))
    current_code = (task.get("current_code", "") or "").strip()
    cited_line = task.get("line", 0)

    if not current_code or len(current_code.split("\n")[0].strip()) < 5:
        return "valid"  # Can't validate short code, trust it

    status, found_line = find_code_in_file(file_path, current_code, cited_line)

    if status == "file_missing":
        task["status"] = "completed"
        task["resolution"] = "already_resolved"
        task["notes"] = "File no longer exists"
        return "already_resolved"

    if status == "not_found":
        task["status"] = "completed"
        task["resolution"] = "already_resolved"
        task["notes"] = "Code no longer present in file (likely fixed by earlier phase)"
        return "already_resolved"

    if status == "exact":
        return "valid"

    if status in ("nearby", "file_wide"):
        shift = abs(found_line - cited_line) if found_line else 0
        task["original_line"] = cited_line
        task["line"] = found_line
        task["line_shifted"] = True

        # If shift is large (>50 lines), the context may have changed significantly
        if shift > 50:
            task["notes"] = f"Line shifted by {shift} — verify fix still applies"
            return "needs_rescan"

        return "line_updated"

    return "valid"


def revalidate_phase_file(phase_file: str, project_dir: str,
                          changed_files: set[str] | None = None,
                          target_task_id: str | None = None) -> dict:
    """Revalidate all pending tasks in a phase file.

    Args:
        phase_file: Path to phase-N-tasks.json
        project_dir: Project root
        changed_files: If set, only revalidate tasks in these files
        target_task_id: If set, only revalidate this specific task

    Returns: stats dict
    """
    with open(phase_file) as f:
        data = json.load(f)

    stats = {"valid": 0, "line_updated": 0, "already_resolved": 0, "needs_rescan": 0, "skipped": 0}
    modified = False

    for task in data.get("tasks", []):
        if task.get("status") != "pending":
            stats["skipped"] += 1
            continue

        # Filter by changed files if specified
        if changed_files is not None:
            task_file = task.get("file", "")
            if task_file not in changed_files:
                stats["skipped"] += 1
                continue

        # Filter by specific task ID if specified
        if target_task_id is not None:
            if task.get("id") != target_task_id:
                stats["skipped"] += 1
                continue

        result = revalidate_task(task, project_dir)
        stats[result] = stats.get(result, 0) + 1

        if result != "valid" and result != "skipped":
            modified = True

    if modified:
        with open(phase_file, "w") as f:
            json.dump(data, f, indent=2)

    return stats


def revalidate_all(project_dir: str, phase_num: int | None = None,
                   task_id: str | None = None, changed_only: bool = False) -> dict:
    """Revalidate task files. Main entry point.

    Args:
        project_dir: Project root
        phase_num: If set, only this phase
        task_id: If set, only this task
        changed_only: If True, only tasks in files modified since HEAD~1
    """
    audit_dir = os.path.join(project_dir, "docs", "audit")
    tasks_dir = os.path.join(audit_dir, "data", "tasks")

    if phase_num is not None:
        pattern = os.path.join(tasks_dir, f"phase-{phase_num}-tasks.json")
    else:
        pattern = os.path.join(tasks_dir, "phase-*-tasks.json")

    task_files = sorted(
        glob.glob(pattern),
        key=lambda f: int(os.path.basename(f).split("-")[1])
    )

    if not task_files:
        return {"error": "No task files found"}

    changed_files = None
    if changed_only:
        changed_files = get_modified_files(project_dir)

    total_stats = {"valid": 0, "line_updated": 0, "already_resolved": 0, "needs_rescan": 0, "skipped": 0}

    for tf in task_files:
        phase = os.path.basename(tf).split("-")[1]
        stats = revalidate_phase_file(tf, project_dir, changed_files, task_id)

        for k, v in stats.items():
            total_stats[k] = total_stats.get(k, 0) + v

        active = {k: v for k, v in stats.items() if v > 0 and k != "skipped"}
        if active:
            print(f"  Phase {phase}: {active}")

    return total_stats


# --- Importable function for rasengan per-task check ---

def quick_check_task(task: dict, project_dir: str) -> bool:
    """Quick pre-fix validation. Returns True if task is still valid.

    Called by rasengan before outputting each task's ACTION.
    If False, rasengan should skip this task (already resolved).
    """
    if task.get("status") != "pending":
        return False

    result = revalidate_task(task, project_dir)
    return result in ("valid", "line_updated")


# --- CLI ---

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: revalidate-tasks.py <project_dir> [--phase N] [--task ID] [--changed-only]")
        sys.exit(1)

    project_dir = sys.argv[1]
    phase_num = None
    task_id = None
    changed_only = False

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--phase" and i + 1 < len(args):
            phase_num = int(args[i + 1])
            i += 2
        elif args[i] == "--task" and i + 1 < len(args):
            task_id = args[i + 1]
            i += 2
        elif args[i] == "--changed-only":
            changed_only = True
            i += 1
        else:
            i += 1

    print(f"Revalidating tasks in {project_dir}")
    if phase_num is not None:
        print(f"  Phase: {phase_num}")
    if task_id is not None:
        print(f"  Task: {task_id}")
    if changed_only:
        print(f"  Changed files only (since HEAD~1)")

    stats = revalidate_all(project_dir, phase_num, task_id, changed_only)

    print(f"\nResults:")
    print(f"  Valid (no change):     {stats.get('valid', 0)}")
    print(f"  Line updated:         {stats.get('line_updated', 0)}")
    print(f"  Already resolved:     {stats.get('already_resolved', 0)}")
    print(f"  Needs rescan:         {stats.get('needs_rescan', 0)}")
    print(f"  Skipped (done/other): {stats.get('skipped', 0)}")

    resolved = stats.get("already_resolved", 0)
    if resolved > 0:
        print(f"\n  {resolved} tasks removed (already fixed by earlier phases)")
