"""Dojutsu pipeline orchestrator — session-resilient state machine.

Chains: rinnegan (detect) → byakugan (analyze) → [rasengan phase N → sharingan phase N] × phases → COMPLETE.
All state on disk. Survives session changes. Agent-agnostic.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
from typing import Optional

try:
    from dojutsu_config import get_dispatch_mode, get_progress_prefix, load_config
except ImportError:
    # Config not available — use defaults
    def get_dispatch_mode() -> str: return "native"
    def get_progress_prefix() -> str: return "[dojutsu]"
    def load_config() -> dict: return {}

from dojutsu_state import (
    append_progress,
    clear_sentinel,
    default_state,
    ensure_sentinel,
    get_head_sha,
    is_eye_complete,
    load_state,
    read_progress,
    resolve_eye_script,
    resolve_skill_dir,
    save_state,
    tag_git_checkpoint,
    transition,
)

MAX_FAILURES_PER_EYE = 2
MAX_ESCALATED_FAILURES = 2


def detect_stage(project_dir: str, state: dict) -> str:
    """Determine current pipeline stage from disk artifacts."""
    audit_dir = os.path.join(project_dir, "docs/audit")
    deep_dir = os.path.join(audit_dir, "deep")
    data_dir = os.path.join(audit_dir, "data")

    # 1. Rinnegan: check for master-audit.md (final output)
    if not os.path.exists(os.path.join(audit_dir, "master-audit.md")):
        return "RINNEGAN_ACTIVE"

    # 2. Byakugan: all 3 deliverables must exist
    byakugan_outputs = ["narrative.md", "scorecard.md", "deployment-plan.md"]
    if not all(os.path.exists(os.path.join(deep_dir, f)) for f in byakugan_outputs):
        return "BYAKUGAN_ACTIVE"

    # 3. Rasengan + Sharingan per-phase loop
    rasengan_state_file = os.path.join(data_dir, "rasengan-state.json")
    if os.path.exists(rasengan_state_file):
        with open(rasengan_state_file) as f:
            rasengan_state = json.load(f)

        completed_phases = rasengan_state.get("phases_completed", [])
        verified_phases = state.get("verified_phases", [])
        unverified = [p for p in completed_phases if p not in verified_phases]

        if unverified:
            return f"SHARINGAN_PHASE_{unverified[0]}"

        if rasengan_state.get("status") == "ALL_PHASES_COMPLETE":
            return "PIPELINE_COMPLETE"

        # Determine which phase rasengan is working on
        current_phase = rasengan_state.get("current_phase", 0)
        return f"RASENGAN_PHASE_{current_phase}"

    # No rasengan state yet — start phase 0
    return "RASENGAN_PHASE_0"


def _get_build_command(project_dir: str) -> str:
    """Detect stack and return appropriate build command."""
    if os.path.exists(os.path.join(project_dir, "tsconfig.json")):
        return "npx tsc --noEmit"
    if os.path.exists(os.path.join(project_dir, "setup.py")) or os.path.exists(
        os.path.join(project_dir, "pyproject.toml")
    ):
        return "python3 -m py_compile"
    if os.path.exists(os.path.join(project_dir, "pom.xml")):
        return "mvn compile -q"
    return "echo 'No build command detected for this stack'"


def _delegate_to_eye(eye: str, project_dir: str, state: dict) -> int:
    """Run an eye's pipeline script and handle its output."""
    try:
        eye_script = resolve_eye_script(eye)
    except FileNotFoundError as e:
        print(f"ERROR: {e}")
        print(f"Ensure the {eye} skill is installed. Run setup.sh to install all skills.")
        return 1

    result = subprocess.run(
        ["python3", eye_script, project_dir],
        capture_output=True, text=True, cwd=project_dir,
    )

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()

    # Check for script errors
    if result.returncode != 0 and not stdout:
        state["failure_counts"][eye] = state["failure_counts"].get(eye, 0) + 1
        save_state(project_dir, state)

        failures = state["failure_counts"][eye]
        if failures >= MAX_FAILURES_PER_EYE + MAX_ESCALATED_FAILURES:
            print(f"BLOCKED: {eye} failed {failures} times. Human review required.")
            print(f"  Last error: {stderr[:500]}")
            return 1

        if failures >= MAX_FAILURES_PER_EYE:
            print(f"WARNING: {eye} failed {failures} times. Consider model escalation.")

        print(f"ERROR: {eye} script failed (attempt {failures}):")
        print(stderr[:500] if stderr else "No error output")
        print(f"\nACTION: Investigate and fix, then run this script again.")
        return 1

    # Check if eye just completed
    if is_eye_complete(stdout, eye):
        checkpoint = get_head_sha(project_dir)
        tag_git_checkpoint(project_dir, f"{eye}-complete")
        append_progress(
            project_dir,
            stage=state["stage"],
            eye=eye,
            summary=f"{eye} complete",
            git_checkpoint=checkpoint,
        )
        # Reset failure counter on success
        state["failure_counts"][eye] = 0
        save_state(project_dir, state)

        print(f"EYE_COMPLETE: {eye}")
        print(f"  Git checkpoint: dojutsu/{eye}-complete ({checkpoint})")
        print(f"\nACTION: Run this script again to advance to the next eye.")
        return 0

    # Eye needs LLM action — pass through with dispatch mode header
    mode = get_dispatch_mode()
    prefix = get_progress_prefix()
    print(f"{prefix} DISPATCH_MODE: {mode}")
    if mode == "agent-mux":
        print(f"{prefix} When ACTION says ROLE: use `printf '{{\"role\":\"<ROLE>\",\"prompt\":\"...\",\"cwd\":\"{project_dir}\"}}' | agent-mux --stdin`")
    else:
        print(f"{prefix} When ACTION says MODEL: use Agent(model=\"<MODEL>\", prompt=\"...\") for subagent dispatch")
    print()
    print(stdout)
    if stderr:
        print(stderr)
    return 0


def _emit_sharingan_action(
    project_dir: str, state: dict, phase_num: int
) -> int:
    """Tell the LLM to run full sharingan for a phase."""
    data_dir = os.path.join(project_dir, "docs/audit/data")
    task_file = os.path.join(data_dir, f"tasks/phase-{phase_num}-tasks.json")

    if not os.path.exists(task_file):
        print(f"ERROR: Phase task file not found: {task_file}")
        return 1

    base_key = f"phase-{phase_num}-start"
    base_commit = state["git_checkpoints"].get(base_key, "HEAD~1")
    try:
        sharingan_skill = resolve_skill_dir("sharingan")
    except FileNotFoundError:
        print("ERROR: sharingan skill not found. Run setup.sh to install.")
        return 1
    sharingan_dir = os.path.join(sharingan_skill, "gates")

    print(f"STAGE: SHARINGAN_PHASE_{phase_num}")
    print(f"SKILL_DIR: {os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}")
    print(f"PROJECT_DIR: {project_dir}")
    print()
    print(f"Phase {phase_num} is complete. Running full sharingan verification.")
    print()
    print(f"ACTION: Run full sharingan (all 5 gates) for Phase {phase_num}.")
    print(f"  MODEL for gates 1,2,4: sonnet")
    print(f"  MODEL for gate 3: haiku (MUST be different model/engine from builder for independence)")
    print(f"  ROLE for gate 3: dojutsu-verifier (if agent-mux — routes to DIFFERENT engine)")
    print(f"  Plan file: {task_file}")
    print(f"  Base commit: {base_commit}")
    print()
    print(f"  Gate 0 (deterministic build — no LLM):")
    print(f"    Run: bash {sharingan_dir}/verify-deterministic.sh {base_commit}")
    print()
    print(f"  Gate 1 (spec compliance — MODEL: sonnet):")
    print(f"    For each task in {task_file}, verify the fix is present with file:line evidence.")
    print()
    print(f"  Gate 2 (code correctness — MODEL: sonnet):")
    print(f"    Check SSOT, security, typing on files modified since {base_commit}.")
    print()
    print(f"  Gate 3 (independent verification — MODEL: haiku, ROLE: dojutsu-verifier):")
    print(f"    Run: bash {sharingan_dir}/verify-independent.sh --plan {task_file} --base {base_commit}")
    print()
    print(f"  Gate 4 (runtime):")
    print(f"    If UI/API changes in this phase: verify with Playwright/curl.")
    print()
    print(f"  Gate 5 (reconciliation):")
    print(f"    Run: bash {sharingan_dir}/reconcile.sh {base_commit}")
    print()
    print(f"  CLEAR verdict → run this script again (Phase {phase_num} will be marked verified)")
    print(f"  BLOCKED verdict → fix issues, then run this script again")
    return 0


def _emit_completion_summary(project_dir: str, state: dict) -> int:
    """Print pipeline completion summary."""
    audit_dir = os.path.join(project_dir, "docs/audit")
    data_dir = os.path.join(audit_dir, "data")
    deep_dir = os.path.join(audit_dir, "deep")

    findings_count = 0
    findings_path = os.path.join(data_dir, "findings.jsonl")
    if os.path.exists(findings_path):
        with open(findings_path) as f:
            findings_count = sum(1 for _ in f)

    verified = state.get("verified_phases", [])
    sessions = state.get("session_count", 1)

    clear_sentinel(project_dir)

    print("PIPELINE_COMPLETE")
    print()
    print(f"  Rinnegan: {findings_count} findings detected")
    print(f"  Byakugan: deep analysis in {deep_dir}/")
    print(f"  Rasengan: all phases fixed")
    print(f"  Sharingan: {len(verified)} phases verified (all CLEAR)")
    print(f"  Sessions used: {sessions}")
    print(f"  Pipeline ID: {state['pipeline_id']}")

    append_progress(
        project_dir,
        stage="PIPELINE_COMPLETE",
        eye="dojutsu",
        summary=f"Pipeline complete: {findings_count} findings, {len(verified)} phases verified",
        git_checkpoint=get_head_sha(project_dir),
    )

    return 0


def run_pipeline(project_dir: str) -> int:
    """Main entry point. Check state, delegate, or emit action."""
    project_dir = os.path.abspath(project_dir)

    # Pre-flight: verify all 5 skills are resolvable
    missing_skills = []
    for skill in ("rinnegan", "byakugan", "rasengan", "sharingan"):
        try:
            resolve_skill_dir(skill)
        except FileNotFoundError:
            missing_skills.append(skill)
    if missing_skills:
        print("ERROR: Missing skills: " + ", ".join(missing_skills))
        print("  Run setup.sh to install all dojutsu skills.")
        print("  Or ensure all 5 skills are in the same agent's skill directory.")
        return 1

    # Load or create state
    state = load_state(project_dir)
    ensure_sentinel(project_dir)

    # Increment session count if this looks like a new session
    last_progress = read_progress(project_dir, last_n=1)
    if last_progress and last_progress[0].get("exit_reason") == "context_exhaustion":
        state["session_count"] = state.get("session_count", 1) + 1
        append_progress(
            project_dir,
            stage=state["stage"],
            eye="dojutsu",
            summary=f"Session {state['session_count']} resumed from context exit",
            git_checkpoint=get_head_sha(project_dir),
        )

    # Detect current stage from disk artifacts
    detected = detect_stage(project_dir, state)

    # If stage changed, transition
    if detected != state["stage"]:
        # For phase transitions, record the start checkpoint
        if detected.startswith("RASENGAN_PHASE_"):
            phase = detected.rsplit("_", 1)[1]
            state["git_checkpoints"][f"phase-{phase}-start"] = get_head_sha(project_dir)

        # For sharingan verification, check if phase was just verified
        if (
            state["stage"].startswith("SHARINGAN_PHASE_")
            and detected.startswith("RASENGAN_PHASE_")
        ):
            # Previous phase was verified (CLEAR) — mark it
            prev_phase = int(state["stage"].rsplit("_", 1)[1])
            if prev_phase not in state["verified_phases"]:
                state["verified_phases"].append(prev_phase)
                state["verified_phases"].sort()

        try:
            transition(state, detected, project_dir)
        except ValueError as e:
            print(f"ERROR: {e}")
            return 1

    # Route to appropriate handler
    if detected == "RINNEGAN_ACTIVE":
        return _delegate_to_eye("rinnegan", project_dir, state)

    if detected == "BYAKUGAN_ACTIVE":
        return _delegate_to_eye("byakugan", project_dir, state)

    if detected.startswith("RASENGAN_PHASE_"):
        return _delegate_to_eye("rasengan", project_dir, state)

    if detected.startswith("SHARINGAN_PHASE_"):
        phase_num = int(detected.rsplit("_", 1)[1])
        return _emit_sharingan_action(project_dir, state, phase_num)

    if detected == "PIPELINE_COMPLETE":
        return _emit_completion_summary(project_dir, state)

    print(f"ERROR: Unknown stage: {detected}")
    return 1
