# Quickstart: Zero to Hero in 5 Steps

This guide gets you from "never heard of dojutsu" to "full codebase audit running" in under 5 minutes.

---

## Step 1: Install

Open your terminal and run these three commands:

```bash
git clone https://github.com/HishamBS/dojutsu.git ~/dojutsu
cd ~/dojutsu
bash setup.sh
```

The installer checks your Python version, installs the skills, and runs the test suite. You will see output like:

```
=== Dojutsu Pipeline Installer ===
Python 3.12 detected
Installed /rinnegan
Installed /rasengan
Installed /sharingan
Installed /byakugan
Installed /dojutsu
...
All tests passed
=== Installation Complete ===
```

If you see "All tests passed" you are good to go.

**Important:** After installation, close and reopen your coding agent so it picks up the new skills.

---

## Step 2: Open Your Coding Agent in Your Project

Navigate to the project you want to audit and start your coding agent there. For example, with Claude Code:

```bash
cd ~/my-project
claude
```

Or with Codex:

```bash
cd ~/my-project
codex
```

You need to be in the root directory of the project you want to scan.

---

## Step 3: Type /dojutsu

In your coding agent, type:

```
/dojutsu
```

That is the only command you need. The pipeline starts automatically.

---

## Step 4: Wait

The pipeline runs through four stages without any input from you:

1. **Scan** -- Rinnegan finds every issue in your codebase
2. **Analyze** -- Byakugan traces dependencies and generates executive reports
3. **Fix** -- Rasengan applies fixes phase by phase, verifying the build after each one
4. **Verify** -- Sharingan runs five verification checks after each phase

A medium-sized project (20K-50K lines) typically takes 4-8 hours total. You do not need to watch it. Check back when it finishes, or periodically to see progress.

**If your session ends before the pipeline finishes** (timeout, crash, context limit), do not worry. Just open a new session in the same project and type `/dojutsu` again. It picks up exactly where it left off. No work is lost.

---

## Step 5: Read the Results

When the pipeline finishes, open the executive report:

```
docs/audit/deep/narrative.md
```

This is the plain-English summary written for stakeholders. It covers what was found, how serious it is, and what was done about it.

For more detail, explore the rest of the audit output:

| What you want | Where to find it |
|--------------|-----------------|
| Big picture overview | `docs/audit/master-audit.md` |
| Executive narrative (for stakeholders) | `docs/audit/deep/narrative.md` |
| Compliance scorecard | `docs/audit/deep/scorecard.md` |
| Detailed findings for a specific area | `docs/audit/layers/*.md` |
| Patterns across multiple areas | `docs/audit/cross-cutting.md` |
| Remediation progress tracker | `docs/audit/progress.md` |
| Machine-readable findings data | `docs/audit/data/findings.jsonl` |

---

## What If I Only Want to Scan (No Fixes)?

Type `/rinnegan` instead of `/dojutsu`. It produces the full audit report without changing any code in your project.

---

## What If Something Goes Wrong?

- **"python3 not found"** -- Install Python 3.9+: `brew install python@3.12` (macOS) or `sudo apt install python3` (Linux)
- **Skills not showing up** -- Close and reopen your coding agent after installation
- **Build breaks during fixing** -- Rasengan stops and reports the error. Fix it manually or run `/dojutsu` again
- **Session ends mid-pipeline** -- Just type `/dojutsu` again in a new session. It resumes automatically.

For more help, see the Troubleshooting section in [README.md](README.md).
