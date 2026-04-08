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
    check_budget,
    clear_dispatch_log,
    clear_sentinel,
    default_state,
    ensure_sentinel,
    get_head_sha,
    get_tokens_used,
    is_eye_complete,
    load_state,
    read_progress,
    resolve_eye_script,
    resolve_skill_dir,
    save_state,
    tag_git_checkpoint,
    transition,
)

# Import revalidation (graceful fallback)
_rinnegan_scripts = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'rinnegan', 'scripts'
)
if os.path.isdir(_rinnegan_scripts):
    import sys as _sys2
    _sys2.path.insert(0, os.path.realpath(_rinnegan_scripts))
try:
    from importlib import import_module as _imp
    _reval = _imp("revalidate-tasks".replace("-", "_")) if False else None  # noqa — dynamic import won't work with hyphens
except Exception:
    _reval = None

def _revalidate_remaining_tasks(project_dir: str, changed_only: bool = True) -> None:
    """Revalidate pending tasks against live source code. Zero tokens."""
    script = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        '..', 'rinnegan', 'scripts', 'revalidate-tasks.py'
    )
    if not os.path.exists(script):
        return
    args = ["python3", script, project_dir]
    if changed_only:
        args.append("--changed-only")
    result = subprocess.run(args, capture_output=True, text=True, cwd=project_dir)
    prefix = get_progress_prefix()
    if result.returncode != 0:
        print(f"{prefix} WARNING: Task revalidation failed (exit {result.returncode})", flush=True)
        if result.stderr.strip():
            print(f"{prefix}   {result.stderr.strip()[:200]}", flush=True)
        return
    if result.stdout.strip():
        for line in result.stdout.strip().split("\n"):
            print(f"{prefix} {line}")


MAX_FAILURES_PER_EYE = 2
MAX_ESCALATED_FAILURES = 2
RATE_LIMIT_KEYWORDS = ["rate limit", "rate_limit", "rate-limit", "limit exceeded",
                       "too many requests", "429", "quota exceeded", "quota",
                       "hit your limit", "resets", "throttl", "retry-after",
                       "temporarily unavailable", "overloaded"]

_DEFAULT_FLAGS = {
    "mode": "audit",
    "phases": None,
    "approval": "interactive",
    "resume": False,
    "status": False,
    "report": False,
    "clean": False,
}


def _pause_pipeline(
    project_dir: str, state: dict, eye: str, reason: str
) -> int:
    """Pause pipeline gracefully — save state, log, print instructions."""
    prefix = get_progress_prefix()
    try:
        budget = load_config().get("pipeline", {}).get("session_token_budget", 500000)
    except Exception:
        budget = 500000
    used = get_tokens_used(project_dir)

    print(f"")
    print(f"{prefix} === PIPELINE PAUSED ===")
    print(f"{prefix} Reason: {reason}")
    print(f"{prefix} Tokens used this session: {used:,} / {budget:,}")
    print(f"{prefix}")
    print(f"{prefix} To resume: start a new session and type /dojutsu")
    print(f"{prefix} The pipeline picks up exactly where it left off.")
    print(f"")

    append_progress(
        project_dir, stage=state["stage"], eye=eye,
        summary=f"Paused: {reason} ({used:,} tokens used)",
        exit_reason="rate_limited",
    )
    save_state(project_dir, state)
    return 0


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
    # Budget check BEFORE dispatching
    try:
        budget = load_config().get("pipeline", {}).get("session_token_budget", 500000)
    except Exception:
        budget = 500000
    ok, reason = check_budget(project_dir, budget)
    if not ok:
        return _pause_pipeline(project_dir, state, eye, reason)

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

    # Check for rate limit errors FIRST (don't retry these)
    combined_output = (stdout + " " + stderr).lower()
    if any(kw in combined_output for kw in RATE_LIMIT_KEYWORDS):
        return _pause_pipeline(project_dir, state, eye, "Rate limited by provider")

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


def _resolve_flags(state: dict, cli_flags: dict | None) -> dict:
    saved = state.get("flags", {})
    if cli_flags and cli_flags.get("resume"):
        return {**_DEFAULT_FLAGS, **saved, "resume": True}
    if cli_flags:
        return {**_DEFAULT_FLAGS, **cli_flags}
    if saved:
        return {**_DEFAULT_FLAGS, **saved}
    return dict(_DEFAULT_FLAGS)


def _emit_audit_complete(project_dir: str, state: dict) -> int:
    audit_dir = os.path.join(project_dir, "docs/audit")
    deep_dir = os.path.join(audit_dir, "deep")
    data_dir = os.path.join(audit_dir, "data")
    prefix = get_progress_prefix()
    findings_count = 0
    fp = os.path.join(data_dir, "findings.jsonl")
    if os.path.exists(fp):
        with open(fp) as f:
            findings_count = sum(1 for _ in f)
    clear_sentinel(project_dir)
    print(f"")
    print(f"{prefix} === AUDIT COMPLETE (read-only mode) ===")
    print(f"{prefix}")
    print(f"{prefix} Findings: {findings_count}")
    print(f"{prefix} Narrative: {deep_dir}/narrative.md")
    print(f"{prefix} Scorecard: {deep_dir}/scorecard.md")
    print(f"{prefix} Deployment plan: {deep_dir}/deployment-plan.md")
    print(f"{prefix}")
    print(f"{prefix} To proceed with fixes:")
    print(f"{prefix}   Run with --fix                    (interactive, approve per phase)")
    print(f"{prefix}   Run with --fix --phases 0,1,2     (fix selected phases only)")
    print(f"{prefix}   Run with --fix --auto             (fully autonomous)")
    print(f"")
    append_progress(project_dir, stage="AUDIT_COMPLETE", eye="dojutsu",
                   summary=f"Audit complete: {findings_count} findings. Fix mode not enabled.")
    return 0


def _handle_status(project_dir: str) -> int:
    prefix = get_progress_prefix()
    try:
        state = load_state(project_dir)
    except (ValueError, FileNotFoundError):
        print(f"{prefix} No pipeline state found.")
        return 0
    flags = state.get("flags", _DEFAULT_FLAGS)
    print(f"{prefix} Stage: {state.get('stage', 'INACTIVE')}")
    print(f"{prefix} Mode: {flags.get('mode', 'audit')}")
    print(f"{prefix} Verified phases: {state.get('verified_phases', [])}")
    print(f"{prefix} Sessions: {state.get('session_count', 1)}")
    if flags.get('phases'):
        print(f"{prefix} Phase filter: {flags['phases']}")
    return 0


def _handle_clean(project_dir: str) -> int:
    import shutil
    prefix = get_progress_prefix()
    audit_dir = os.path.join(project_dir, "docs/audit")
    if os.path.exists(audit_dir):
        shutil.rmtree(audit_dir)
        print(f"{prefix} Removed {audit_dir}/")
    else:
        print(f"{prefix} No audit data found.")
    return 0


def _handle_report(project_dir: str) -> int:
    prefix = get_progress_prefix()
    deep_dir = os.path.join(project_dir, "docs/audit/deep")
    print(f"{prefix} To regenerate reports, delete existing files in {deep_dir}/ then run audit.")
    return 0


def _skip_phase(project_dir: str, state: dict, phase_num: int, flags: dict) -> int:
    prefix = get_progress_prefix()
    print(f"{prefix} Skipping phase {phase_num} (not in --phases {flags['phases']})")
    data_dir = os.path.join(project_dir, "docs/audit/data")
    rs_file = os.path.join(data_dir, "rasengan-state.json")
    if os.path.exists(rs_file):
        with open(rs_file) as f:
            rs = json.load(f)
        if phase_num not in rs.get("phases_completed", []):
            rs.setdefault("phases_completed", []).append(phase_num)
            with open(rs_file, "w") as f:
                json.dump(rs, f, indent=2)
    if phase_num not in state.get("verified_phases", []):
        state.setdefault("verified_phases", []).append(phase_num)
        state["verified_phases"].sort()
        state.setdefault("skipped_phases", []).append(phase_num)
        save_state(project_dir, state)
    return 0


def _emit_phase_approval(project_dir: str, state: dict, phase_num: int) -> int:
    prefix = get_progress_prefix()
    print(f"")
    print(f"{prefix} === PHASE {phase_num} VERIFIED (CLEAR) ===")
    print(f"{prefix} To continue to next phase, run this script again.")
    print(f"{prefix} To stop here, do nothing.")
    print(f"{prefix} To switch to auto mode, run with --fix --auto")
    print(f"")
    return 0


def run_pipeline(project_dir: str, flags: dict | None = None) -> int:
    """Main entry point. Check state, delegate, or emit action."""
    project_dir = os.path.abspath(project_dir)

    # Handle informational commands (no state mutation)
    if flags and flags.get("status"):
        return _handle_status(project_dir)
    if flags and flags.get("report"):
        return _handle_report(project_dir)
    if flags and flags.get("clean"):
        return _handle_clean(project_dir)

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

    # Resolve flags: CLI > saved > defaults
    effective_flags = _resolve_flags(state, flags)
    state["flags"] = effective_flags
    save_state(project_dir, state)

    # Startup revalidation: catch any code changes since last run
    if state.get("stage", "").startswith(("RASENGAN_PHASE_", "SHARINGAN_PHASE_")):
        prefix = get_progress_prefix()
        print(f"{prefix} Startup: revalidating pending tasks against live code...")
        _revalidate_remaining_tasks(project_dir, changed_only=False)

    # Detect session resume (rate limit, context exhaustion, or manual pause)
    last_progress = read_progress(project_dir, last_n=1)
    is_resume = False
    resume_reason = ""
    if last_progress:
        last_exit = last_progress[0].get("exit_reason")
        if last_exit in ("rate_limited", "context_exhaustion", "manual_pause"):
            is_resume = True
            resume_reason = last_progress[0].get("summary", "unknown")
            state["session_count"] = state.get("session_count", 1) + 1
            # Clear dispatch log for fresh budget in new session
            clear_dispatch_log(project_dir)
            # Clear exit_reason so we don't re-detect on next run within same session
            append_progress(
                project_dir, stage=state["stage"], eye="dojutsu",
                summary=f"Session {state['session_count']} started",
                exit_reason=None,
            )

    if is_resume:
        prefix = get_progress_prefix()
        print(f"")
        print(f"{prefix} === RESUMING PIPELINE (session {state['session_count']}) ===")
        print(f"{prefix}")
        print(f"{prefix} Previous session: {resume_reason}")
        print(f"{prefix} Resuming from: {state['stage']}")
        print(f"{prefix}")
        print(f"{prefix} *** IMPORTANT: Follow the ACTION below. Do NOT improvise. ***")
        print(f"{prefix} *** Do NOT write scripts to generate files. The pipeline handles it. ***")
        print(f"")

    # Detect current stage from disk artifacts
    detected = detect_stage(project_dir, state)

    # MODE ENFORCEMENT: audit mode stops before rasengan
    if effective_flags["mode"] == "audit":
        if detected.startswith(("RASENGAN_PHASE_", "SHARINGAN_PHASE_")) or detected == "PIPELINE_COMPLETE":
            return _emit_audit_complete(project_dir, state)

    # PHASE FILTER: skip phases not in --phases list
    if effective_flags["mode"] == "fix" and effective_flags.get("phases") is not None:
        if detected.startswith("RASENGAN_PHASE_"):
            phase_num = int(detected.rsplit("_", 1)[1])
            if phase_num not in effective_flags["phases"]:
                return _skip_phase(project_dir, state, phase_num, effective_flags)

    # If stage changed, transition
    if detected != state["stage"]:
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
                # Phase just verified — revalidate remaining tasks against live code
                prefix = get_progress_prefix()
                print(f"{prefix} Revalidating remaining tasks after Phase {prev_phase} fixes...")
                _revalidate_remaining_tasks(project_dir, changed_only=True)

                # Interactive approval gate
                if effective_flags.get("approval") == "interactive" and effective_flags["mode"] == "fix":
                    return _emit_phase_approval(project_dir, state, prev_phase)

        try:
            transition(state, detected, project_dir)
        except ValueError as e:
            print(f"ERROR: {e}")
            return 1

        # Record phase start checkpoint AFTER successful transition
        if detected.startswith("RASENGAN_PHASE_"):
            phase = detected.rsplit("_", 1)[1]
            state["git_checkpoints"][f"phase-{phase}-start"] = get_head_sha(project_dir)
            save_state(project_dir, state)

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
