# Dojutsu -- Agent Setup & Operations Guide

This document is for coding agents (Claude Code, Codex, OpenCode, Gemini CLI). If a human gives you this file and asks you to set up or run dojutsu, follow these instructions exactly.

---

## One-Line Install

```bash
git clone https://github.com/HishamBS/dojutsu.git ~/dojutsu && cd ~/dojutsu && bash setup.sh
```

If the repo already exists at `~/dojutsu`, skip the clone:

```bash
cd ~/dojutsu && git pull && bash setup.sh
```

---

## Prerequisites (verify before install)

Run these checks. All must pass before proceeding to setup.

```bash
# Python 3.9+ required
python3 --version   # must print 3.9.0 or higher

# Git required
git --version

# At least one coding agent must be on PATH
# Check whichever applies:
which claude    # Claude Code
which codex     # Codex
which opencode  # OpenCode
which gemini    # Gemini CLI
```

If Python is missing:
- macOS: `brew install python@3.12`
- Ubuntu/Debian: `sudo apt install python3`
- WSL: `sudo apt install python3`

---

## What setup.sh Does

The installer is interactive. It will prompt the human for choices. Here is what it does:

1. **Checks Python version.** Exits with instructions if Python < 3.9.
2. **Detects coding agents on PATH.** Scans for Claude Code, Codex, OpenCode, Gemini CLI.
3. **Prompts for install mode:**
   - **Native mode** -- uses the current agent only. Simpler. Recommended if only one agent is available.
   - **Agent-Mux mode** -- distributes work across multiple engines. Requires agent-mux binary installed.
4. **Creates symlinks.** Links the 5 skills (rinnegan, byakugan, rasengan, sharingan, dojutsu) into each detected agent's skill directory:
   - Claude Code: `~/.claude/commands/`
   - Codex: `~/.codex/skills/`
   - OpenCode: `~/.config/opencode/command/`
   - Gemini CLI: `~/.gemini/skills/`
5. **Updates dojutsu.toml** with the chosen dispatch mode, detected engines, and verifier engine.
6. **Runs the test suite** to confirm installation.
7. **Verifies symlinks** resolve correctly.

Re-running setup.sh is safe (idempotent). Existing non-symlink directories are backed up with a timestamp.

---

## Verify Installation

After setup.sh completes, the human must restart their coding agent. Then verify:

```bash
# Check symlinks exist (example for Claude Code)
ls -la ~/.claude/commands/ | grep -E 'rinnegan|byakugan|rasengan|sharingan|dojutsu'

# Check all 5 skills resolve from dojutsu's perspective
python3 ~/dojutsu/skills/dojutsu/scripts/run-pipeline.py /path/to/any/project --status
```

Expected output for `--status` on a fresh project: `[dojutsu] No pipeline state found.`

If skills are missing: re-run `bash ~/dojutsu/setup.sh`.

---

## Configuration (dojutsu.toml)

The config file lives at `~/dojutsu/skills/dojutsu/dojutsu.toml`. All pipeline behavior is driven by this file. Key sections to customize:

### Token Budget

```toml
[pipeline]
session_token_budget = 500000   # Claude Max subscription
# session_token_budget = 250000 # Claude Pro subscription
# session_token_budget = 500000 # Codex
```

Set this to match the human's subscription tier. The pipeline auto-pauses when the budget is exceeded and resumes in a new session.

### Model Tiers

```toml
[models.tiers.cheap]
claude = "claude-haiku-4-5"     # scanning, aggregation
codex = "gpt-5.4-mini"

[models.tiers.mid]
claude = "claude-sonnet-4-6"    # fixing, analysis, verification
codex = "gpt-5.4-mini"

[models.tiers.premium]
claude = "claude-opus-4-6"      # narratives, master reports
codex = "gpt-5.4"
```

Update model IDs here when new models release. Pipeline code references tiers, never model IDs directly.

### Dispatch Mode

```toml
[dispatch]
mode = "native"                 # "native" or "agent-mux"
default_engine = "claude"
available_engines = ["claude"]
verifier_engine = "claude"      # must differ from default_engine when possible
```

Set by setup.sh. Only change manually if adding/removing engines after initial setup.

### Confidence Routing

```toml
[confidence]
auto_fix = ["high", "medium"]   # rasengan auto-fixes these
human_review = ["low"]          # rasengan pauses for human decision
skip_emit = true                # findings matching SKIP criteria are not emitted
```

---

## Usage: Run an Audit (read-only, no code changes)

```bash
/dojutsu
```

By default, dojutsu runs in audit-only mode. It chains rinnegan (scan) and byakugan (analyze) then stops. No files in the project are modified.

**Output produced:**
- `docs/audit/master-audit.md` -- navigation hub with executive summary
- `docs/audit/layers/*.md` -- per-layer detailed findings
- `docs/audit/deep/narrative.md` -- executive narrative for stakeholders
- `docs/audit/deep/scorecard.md` -- compliance scorecard
- `docs/audit/deep/deployment-plan.md` -- rollout plan
- `docs/audit/data/findings.jsonl` -- machine-readable findings (one JSON per line)

---

## Usage: Audit + Fix

```bash
/dojutsu --fix                  # interactive (approve after each phase)
/dojutsu --fix --auto           # fully autonomous (no approval gates)
/dojutsu --fix --phases 0,1,2   # fix selected phases only
```

The pipeline runs: rinnegan (scan) -> byakugan (analyze) -> [rasengan phase N -> sharingan phase N] x phases -> PIPELINE_COMPLETE.

**Confidence routing during fixes:**
- **HIGH + MEDIUM** findings: auto-fixed by rasengan without asking
- **LOW** findings: presented for human review. Human decides fix/skip/skip-all-for-rule. Decisions persist in `docs/audit/data/human-decisions.json` and are not re-asked.

**Interactive mode** (default with `--fix`): after each phase is verified, the pipeline pauses and asks to continue. The human can stop, switch to auto mode, or proceed.

**Autonomous mode** (`--fix --auto`): no pauses between phases. Runs until complete.

---

## Resuming After Interruption

All state is saved to disk after every meaningful step. Resume is automatic.

| Scenario | What to do |
|----------|-----------|
| Session timeout / crash | Open new session, type `/dojutsu`. Resumes automatically. |
| Rate limited by provider | Pipeline auto-pauses with message. Open new session, type `/dojutsu`. |
| Context window exhaustion | Same as rate limit. New session = fresh context + fresh budget. |
| Human paused manually | Type `/dojutsu` to continue from where you stopped. |
| Switched computers | Sync `docs/audit/` directory (via git), run `/dojutsu`. |

**What NOT to do on resume:**
- Do not reconstruct pipeline state from memory of a previous session
- Do not re-run completed stages manually
- Do not edit `dojutsu-state.json` by hand (HMAC-signed, manual edits will be rejected)

---

## State Files Reference

All state files live under `docs/audit/data/` in the project being audited.

| File | What it is | Created when |
|------|-----------|-------------|
| `dojutsu-state.json` | HMAC-signed pipeline state (stage, phases, flags, checkpoints) | First `/dojutsu` run |
| `dojutsu-progress.jsonl` | Append-only progress narrative (one JSON per event) | First stage transition |
| `dispatch-log.jsonl` | Token usage per dispatch (cleared on session resume) | First agent dispatch |
| `human-decisions.json` | Persisted human decisions for LOW-confidence findings | First LOW finding reviewed |
| `.dojutsu-active` | Sentinel file with PID (prevents concurrent runs) | Pipeline start |
| `.dojutsu-hmac-key` | Per-project HMAC key (32-byte hex, 0600 perms) | First state save |
| `rasengan-state.json` | Rasengan's internal phase tracking | First rasengan phase |
| `findings.jsonl` | All findings from rinnegan (one JSON per finding) | Rinnegan completion |
| `tasks/phase-N-tasks.json` | Task lists for each remediation phase | Rinnegan completion |

---

## Troubleshooting

### HMAC mismatch error
State file was modified outside the pipeline. Delete `docs/audit/data/dojutsu-state.json` and run `/dojutsu` to restart. The progress narrative (`dojutsu-progress.jsonl`) is preserved.

### Missing skills error
One or more of the 5 skills cannot be found. Re-run `bash ~/dojutsu/setup.sh` and restart the coding agent.

### Stale sentinel ("pipeline already active")
The `.dojutsu-active` file contains a PID that no longer exists. The pipeline auto-cleans stale sentinels on next run. If it persists, delete `docs/audit/data/.dojutsu-active` manually.

### Budget exceeded
The pipeline auto-pauses when token usage exceeds `session_token_budget` in dojutsu.toml. Start a new session and run `/dojutsu` -- the budget counter resets per session.

### Build breaks during fix phase
Rasengan stops and reports the error. Options:
1. Fix the build error manually, then run `/dojutsu` to continue
2. Mark the task as `skipped` in the phase task JSON
3. `git revert HEAD` to undo the last phase commit, then run `/dojutsu`

### Rate limited by provider
Pipeline auto-pauses with resume instructions. Start a new session and type `/dojutsu`.

---

## Project Structure

```
~/dojutsu/
  setup.sh                  # Interactive installer (idempotent)
  uninstall.sh              # Remove skill symlinks
  run-tests.sh              # Test suite (93 tests)
  AGENTS.md                 # This file (agent setup guide)
  README.md                 # Human user guide (443 lines)
  QUICKSTART.md             # Human quickstart (123 lines)
  skills/
    dojutsu/                # Orchestrator (chains all 4 eyes)
      SKILL.md              # Operational instructions for /dojutsu
      dojutsu.toml          # SSOT config for entire pipeline
      scripts/              # Python orchestrator (state machine, delegation)
    rinnegan/               # Scanner (20 engineering rules)
    byakugan/               # Analyst (dependency tracing, narratives)
    rasengan/               # Fixer (autonomous remediation)
    sharingan/              # Verifier (6 evidence-based gates)
```
