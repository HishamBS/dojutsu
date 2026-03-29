"""Dojutsu pipeline state management.

HMAC-signed state, progress narrative, sentinel file, git checkpoints.
Designed for session resilience — all state on disk, agent-agnostic.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

STATE_FILE = "docs/audit/data/dojutsu-state.json"
PROGRESS_FILE = "docs/audit/data/dojutsu-progress.jsonl"
SENTINEL_FILE = "docs/audit/data/.dojutsu-active"
HMAC_KEY_FILE = "docs/audit/data/.dojutsu-hmac-key"  # Per-project, resolved relative to project_dir

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "REVIEW": 4}

LEGAL_TRANSITIONS: dict[str, list[str]] = {
    "INACTIVE": ["RINNEGAN_ACTIVE"],
    "RINNEGAN_ACTIVE": ["BYAKUGAN_ACTIVE"],
    "BYAKUGAN_ACTIVE": ["RASENGAN_PHASE_0"],
}
# Dynamic transitions for RASENGAN_PHASE_N / SHARINGAN_PHASE_N are validated separately


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_hmac_key(project_dir: str) -> bytes:
    """Read or create per-project HMAC key."""
    key_path = Path(os.path.join(project_dir, HMAC_KEY_FILE))
    if key_path.exists():
        return key_path.read_bytes().strip()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32).hex().encode()
    key_path.write_bytes(key)
    key_path.chmod(0o600)
    return key


# Module-level cache for project_dir used by HMAC functions
_current_project_dir: str = ""


def _compute_hmac(state: dict) -> str:
    """Compute HMAC-SHA256 over stage + last_updated."""
    key = _get_hmac_key(_current_project_dir)
    payload = f"{state['stage']}|{state['last_updated']}".encode()
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _verify_hmac(state: dict) -> bool:
    """Verify state file integrity."""
    expected = state.get("hmac", "")
    computed = _compute_hmac(state)
    return hmac.compare_digest(expected, computed)


def default_state() -> dict:
    """Create a fresh pipeline state."""
    now = _now_iso()
    state = {
        "pipeline_id": str(uuid.uuid4()),
        "started_at": now,
        "last_updated": now,
        "stage": "INACTIVE",
        "current_eye": None,
        "current_phase": None,
        "verified_phases": [],
        "failure_counts": {
            "rinnegan": 0, "byakugan": 0, "rasengan": 0, "sharingan": 0,
        },
        "session_count": 1,
        "last_agent": os.environ.get("CLAUDE_MODEL", "unknown"),
        "git_checkpoints": {},
        "history": [],
        "hmac": "",
    }
    state["hmac"] = _compute_hmac(state)
    return state


def load_state(project_dir: str) -> dict:
    """Load and HMAC-verify state from disk. Returns default if no state file."""
    global _current_project_dir
    _current_project_dir = project_dir
    path = os.path.join(project_dir, STATE_FILE)
    if not os.path.exists(path):
        return default_state()
    with open(path) as f:
        state = json.load(f)
    if not _verify_hmac(state):
        raise ValueError(
            "HMAC mismatch on dojutsu-state.json — state file may be tampered. "
            "Delete the file to restart the pipeline, or investigate."
        )
    return state


def save_state(project_dir: str, state: dict) -> None:
    """Save state to disk with fresh HMAC."""
    state["last_updated"] = _now_iso()
    state["hmac"] = _compute_hmac(state)
    path = os.path.join(project_dir, STATE_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


def transition(
    state: dict,
    new_stage: str,
    project_dir: str,
    reason: str = "",
) -> None:
    """Transition to a new stage. Validates, updates state, tags git, logs progress."""
    old_stage = state["stage"]

    # Validate transition
    if not _is_legal_transition(old_stage, new_stage):
        raise ValueError(
            f"Illegal transition: {old_stage} → {new_stage}. "
            f"Check pipeline state."
        )

    state["history"].append({
        "from": old_stage,
        "to": new_stage,
        "timestamp": _now_iso(),
        "reason": reason or f"auto: {old_stage} → {new_stage}",
    })
    state["stage"] = new_stage

    # Update current_eye and current_phase from stage name
    if new_stage.startswith("RINNEGAN"):
        state["current_eye"] = "rinnegan"
        state["current_phase"] = None
    elif new_stage.startswith("BYAKUGAN"):
        state["current_eye"] = "byakugan"
        state["current_phase"] = None
    elif new_stage.startswith("RASENGAN_PHASE_"):
        state["current_eye"] = "rasengan"
        state["current_phase"] = int(new_stage.rsplit("_", 1)[1])
    elif new_stage.startswith("SHARINGAN_PHASE_"):
        state["current_eye"] = "sharingan"
        state["current_phase"] = int(new_stage.rsplit("_", 1)[1])
    elif new_stage == "PIPELINE_COMPLETE":
        state["current_eye"] = None
        state["current_phase"] = None

    state["stage_entered_at"] = _now_iso()
    save_state(project_dir, state)
    tag_git_checkpoint(project_dir, new_stage.lower().replace("_", "-"))


def _is_legal_transition(old: str, new: str) -> bool:
    """Check if a stage transition is allowed."""
    # INACTIVE can jump to any detected stage (resume from partial data)
    if old == "INACTIVE":
        return True
    # Static transitions
    if old in LEGAL_TRANSITIONS and new in LEGAL_TRANSITIONS[old]:
        return True
    # Dynamic: RASENGAN_PHASE_N → SHARINGAN_PHASE_N
    if old.startswith("RASENGAN_PHASE_") and new.startswith("SHARINGAN_PHASE_"):
        return old.rsplit("_", 1)[1] == new.rsplit("_", 1)[1]
    # Dynamic: SHARINGAN_PHASE_N → RASENGAN_PHASE_N (BLOCKED, re-fix)
    if old.startswith("SHARINGAN_PHASE_") and new.startswith("RASENGAN_PHASE_"):
        return True
    # Dynamic: SHARINGAN_PHASE_N → PIPELINE_COMPLETE (last phase verified)
    if old.startswith("SHARINGAN_PHASE_") and new == "PIPELINE_COMPLETE":
        return True
    # Dynamic: BYAKUGAN_ACTIVE → RASENGAN_PHASE_N
    if old == "BYAKUGAN_ACTIVE" and new.startswith("RASENGAN_PHASE_"):
        return True
    return False


# --- Progress Narrative ---

def append_progress(
    project_dir: str,
    *,
    stage: str = "",
    eye: str = "",
    summary: str = "",
    decisions: Optional[list[str]] = None,
    next_priority: str = "",
    git_checkpoint: str = "",
    exit_reason: Optional[str] = None,
) -> None:
    """Append an entry to the progress narrative JSONL."""
    path = os.path.join(project_dir, PROGRESS_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    entry = {
        "timestamp": _now_iso(),
        "stage": stage,
        "eye": eye,
        "summary": summary,
        "decisions": decisions or [],
        "next_priority": next_priority,
        "git_checkpoint": git_checkpoint or get_head_sha(project_dir),
        "exit_reason": exit_reason,
    }
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")


def read_progress(project_dir: str, last_n: int = 5) -> list[dict]:
    """Read last N progress entries."""
    path = os.path.join(project_dir, PROGRESS_FILE)
    if not os.path.exists(path):
        return []
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries[-last_n:]


# --- Sentinel File ---

def ensure_sentinel(project_dir: str) -> None:
    """Create sentinel file marking pipeline as active."""
    path = os.path.join(project_dir, SENTINEL_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(str(os.getpid()))


def is_active(project_dir: str) -> bool:
    """Check if pipeline is active (sentinel exists and process alive)."""
    path = os.path.join(project_dir, SENTINEL_FILE)
    if not os.path.exists(path):
        return False
    try:
        pid = int(Path(path).read_text().strip())
        os.kill(pid, 0)  # Check if process exists
        return True
    except (ValueError, ProcessLookupError, PermissionError):
        # Stale sentinel — clean up
        os.remove(path)
        return False


def clear_sentinel(project_dir: str) -> None:
    """Remove sentinel file."""
    path = os.path.join(project_dir, SENTINEL_FILE)
    if os.path.exists(path):
        os.remove(path)


# --- Git Checkpoints ---

def tag_git_checkpoint(project_dir: str, label: str) -> None:
    """Tag current HEAD for rollback."""
    subprocess.run(
        ["git", "tag", "-f", f"dojutsu/{label}", "HEAD"],
        cwd=project_dir, capture_output=True,
    )


def get_head_sha(project_dir: str) -> str:
    """Get current HEAD short SHA."""
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=project_dir, capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


# --- Eye Script Resolution ---

def _get_skills_search_paths() -> list[str]:
    """Return list of directories to search for sibling skills, in priority order."""
    paths = []
    # 1. Resolve from THIS skill's location (sibling directories)
    this_skill = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parent = os.path.dirname(this_skill)
    if os.path.isdir(parent):
        paths.append(parent)
    # 2. Common agent skill locations (auto-detected, not hardcoded)
    for agent_dir in [
        os.path.expanduser("~/.coding-agent/skills"),
        os.path.expanduser("~/.claude/commands"),
        os.path.expanduser("~/.codex/skills"),
        os.path.expanduser("~/.config/opencode/command"),
        os.path.expanduser("~/.gemini/skills"),
    ]:
        if os.path.isdir(agent_dir) and agent_dir not in paths:
            paths.append(agent_dir)
    return paths


def resolve_skill_dir(skill: str) -> str:
    """Find a sibling skill's directory."""
    for base in _get_skills_search_paths():
        skill_dir = os.path.join(base, skill)
        if os.path.isdir(skill_dir):
            return os.path.realpath(skill_dir)
    raise FileNotFoundError(
        f"Cannot find skill '{skill}'. Run setup.sh to install dojutsu skills."
    )


def resolve_eye_script(eye: str) -> str:
    """Find a sibling eye's run-pipeline.py."""
    skill_dir = resolve_skill_dir(eye)
    script = os.path.join(skill_dir, "scripts", "run-pipeline.py")
    if os.path.exists(script):
        return script
    raise FileNotFoundError(
        f"Cannot find run-pipeline.py for {eye} in {skill_dir}/scripts/"
    )


def is_eye_complete(stdout: str, eye: str) -> bool:
    """Check if an eye's pipeline script output indicates completion."""
    for line in stdout.split("\n"):
        stripped = line.strip()
        if stripped.startswith("STATE:"):
            state_value = stripped.split(":", 1)[1].strip()
            if state_value in ("COMPLETE", "PIPELINE_COMPLETE"):
                return True
            if eye == "rasengan" and "ALL_PHASES_COMPLETE" in stripped:
                return True
    return False
