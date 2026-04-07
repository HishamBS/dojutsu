# Dojutsu

## What is Dojutsu?

Dojutsu is a toolkit that automatically finds problems in your code, analyzes how serious they are, fixes them, and verifies the fixes are correct. You install it once, type one command, and it does the rest. No manual code review, no spreadsheets of issues, no guessing about what to fix first.

Think of it as hiring a team of specialists who work around the clock: one finds every problem, one figures out the dependencies and priorities, one applies the fixes, and one double-checks that nothing broke. Dojutsu coordinates all of them so you do not have to.

> **Setting up with a coding agent?** Give your agent the [AGENTS.md](AGENTS.md) file -- it has everything it needs to install, configure, and run dojutsu on your project.

---

## What Does It Do?

**Before Dojutsu:**
Your codebase has hundreds or thousands of issues -- security gaps, duplicated logic, missing type safety, hardcoded values, untested endpoints. You know they exist but finding them all would take weeks. Prioritizing them would take longer. Fixing them without breaking things would take even longer.

**After Dojutsu:**
Every issue is cataloged with its exact file and line number. Each one has a severity rating and a recommended fix. They are organized into phases with the right order of operations (you would not paint a wall before fixing the foundation). The fixes are applied automatically, verified automatically, and committed to git with clean history. You get a full audit report your team can read.

**Real-world example:** A codebase scanned with dojutsu had 1,690 findings across 20 engineering rule categories. Dojutsu organized them into 11 phases, fixed them in dependency order, verified each phase, and produced documentation explaining every change.

---

## What's New in v4

- **Confidence-based findings.** Every finding now carries a confidence level (HIGH, MEDIUM, or LOW). HIGH-confidence findings are applied automatically. LOW-confidence findings are surfaced for human review before any changes are made, keeping you in control of uncertain fixes.

- **Smart model routing.** The pipeline routes work to the right model tier for the job. Scanning and aggregation use fast, cheap models (Haiku-tier). Code understanding and fixing use mid-tier models (Sonnet-tier). Narrative generation and complex analysis use premium models (Opus-tier). This cuts cost without sacrificing quality where it matters.

- **Session-resilient pipeline.** If your coding agent session ends mid-pipeline (timeout, crash, context limit), just open a new session and run `/dojutsu` again. It reads saved state files and picks up exactly where it left off. No work is repeated and no progress is lost.

- **Human-in-the-loop review.** Findings with LOW confidence are not applied blindly. They are presented for your review with the reasoning behind the suggestion, so you can approve, modify, or skip them before any code is changed.

---

## The Five Eyes

Dojutsu is made up of five skills, each named after a visual power from Naruto. Together, they form a complete quality pipeline.

### Rinnegan -- The Scanner

Rinnegan scans your entire codebase against 20 engineering rules covering security, typing, performance, architecture, and more. It examines every single file -- no sampling, no shortcuts. It produces a structured audit with findings organized by severity, by architectural layer, and by remediation phase. Each finding includes exact file paths, line numbers, the current problematic code, the recommended replacement, and a confidence level (HIGH, MEDIUM, or LOW). HIGH-confidence findings are applied automatically. LOW-confidence findings are flagged for human review before any changes are made, so you stay in control of uncertain fixes. When rinnegan finishes, you have a complete picture of every issue in your project.

### Byakugan -- The Analyst

Byakugan takes the raw findings from rinnegan and goes deeper. It traces dependencies between files to understand blast radius -- if you change this function, what else breaks? It clusters related findings so your team can see patterns instead of individual issues. It produces an executive narrative (a plain-English summary for stakeholders), a compliance scorecard (how close you are to production-ready), and a deployment plan (what order to roll out changes safely).

### Rasengan -- The Fixer

Rasengan reads the phase-ordered task files that rinnegan created and starts fixing issues automatically. It works one phase at a time, respecting the dependency order (foundation fixes before security fixes, security before architecture, and so on). After applying each fix, it verifies the project still builds. After completing each phase, it commits the changes to git with a clear message describing what was fixed. If something breaks, it stops and tells you exactly what went wrong.

### Sharingan -- The Verifier

Sharingan is the quality gate. It runs five layers of verification to make sure your code actually works, not just that it looks right. It checks that the project compiles and passes linting. It verifies every requirement with file-and-line evidence. It checks for security issues, duplicated code, and incomplete implementations. It sends the code to an independent reviewer that has zero knowledge of how the fixes were made. And if your project has a user interface or API, it starts the server and checks that pages load and endpoints respond. Only when all five layers pass does sharingan give the green light.

### Dojutsu -- The Orchestrator

Dojutsu is the conductor. When you type `/dojutsu`, it chains all four eyes together in the right order: rinnegan scans, byakugan analyzes, then rasengan fixes and sharingan verifies each phase in a loop until everything is done. You do not need to remember which skill to run next or when to switch. Dojutsu handles that. If your session ends mid-pipeline, just run `/dojutsu` again -- it picks up exactly where it left off.

---

## Prerequisites

You need two things:

1. **Python 3.9 or newer.** Check by opening your terminal and running:
   ```
   python3 --version
   ```
   If you see `Python 3.9.0` or higher, you are good. If not, install it:
   - **macOS:** `brew install python@3.12`
   - **Linux:** `sudo apt install python3` (or your distro's equivalent)
   - **Windows (WSL):** Install [WSL](https://learn.microsoft.com/en-us/windows/wsl/install), then `sudo apt install python3` inside your WSL terminal
   - **Windows (native):** Download from [python.org](https://python.org) and ensure `python3` is on your PATH

2. **A coding agent.** You need one of these tools installed and working:
   - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (recommended)
   - [Codex](https://github.com/openai/codex)
   - [OpenCode](https://github.com/opencode-ai/opencode)
   - [Gemini CLI](https://github.com/google-gemini/gemini-cli)

   If you can open your terminal, type the agent's command, and get a response, you are ready.

**Platform support:** macOS, Linux, and Windows (via WSL). The installer (`setup.sh`) is a bash script. On Windows, use WSL to run it.

---

## Install

Open your terminal and run these three commands:

```bash
git clone https://github.com/HishamBS/dojutsu.git ~/dojutsu
cd ~/dojutsu
bash setup.sh
```

**What the installer does:**

1. **Checks your Python version.** If Python 3.9+ is not found, it tells you exactly how to install it and stops.

2. **Detects your coding agents.** It scans your PATH for supported agents (Claude Code, Codex, OpenCode, Gemini CLI) and reports which ones are available.

3. **Lets you choose an installation mode.** You pick between Agent-Mux mode (distributes work across multiple engines for speed and cost savings) or Native mode (uses your current agent only with model tier hints). If only one agent is detected, Native mode is the simpler choice.

4. **Creates symlinks for all five skills.** For each detected agent, it creates symbolic links from the agent's skill directory (e.g., `~/.claude/commands/`, `~/.codex/skills/`) to the dojutsu source files. This makes the `/rinnegan`, `/byakugan`, `/rasengan`, `/sharingan`, and `/dojutsu` commands available in your agent. Existing non-symlink directories are backed up before linking.

5. **Updates the dispatch configuration.** It writes the chosen mode and detected engines into `dojutsu.toml` so the pipeline knows how to route work.

6. **Makes scripts executable.** All shell scripts in the skills are marked as runnable.

7. **Runs the test suite.** Tests run automatically to make sure everything installed correctly. If any fail, you will see a warning -- the skills are still installed but may have issues.

8. **Verifies symlinks.** It confirms every skill symlink resolves correctly and is readable by your agent.

After the installer finishes, **restart your coding agent** (close and reopen it) so it picks up the new skills.

**Want your coding agent to handle setup for you?** Give it the [AGENTS.md](AGENTS.md) file -- it contains step-by-step instructions any coding agent can follow to install, configure, and run dojutsu on your project.

---

## Usage

### The One-Command Pipeline

1. Open your coding agent in the project you want to audit.
2. Type:
   ```
   /dojutsu
   ```
3. That is it. The pipeline runs automatically.

### What You See at Each Step

When you run `/dojutsu`, the orchestrator starts working through each eye in sequence. Here is what you will see:

**During Rinnegan (scanning):**
- "Creating inventory..." -- it catalogs every file in your project
- "Running grep scanner..." -- it finds mechanical violations instantly
- "Dispatching scanners..." -- it sends groups of files to be analyzed in depth
- "Aggregating findings..." -- it merges everything into one structured dataset
- "Enriching findings..." -- it adds fix instructions to each finding
- "Generating documentation..." -- it creates the audit reports

**During Byakugan (analysis):**
- "Building dependency graph..." -- it maps how your files connect
- "Clustering findings..." -- it groups related issues together
- "Generating impact analysis..." -- it traces blast radius for each cluster
- "Writing narrative..." -- it creates the executive summary
- "Generating scorecard..." -- it rates your codebase readiness

**During Rasengan (fixing):**
- "Phase 0: Foundation -- 23 tasks" -- it tells you which phase it is on
- "Fixing: src/config.ts:42" -- it shows each file being fixed
- "Build check: PASS" -- it verifies the build after each fix
- "Phase 0 complete. Committing..." -- it saves progress to git

**During Sharingan (verifying):**
- "Gate 0: Build check..." -- it compiles and lints your project
- "Gate 1: Spec compliance..." -- it verifies each requirement with evidence
- "Gate 2: Code correctness..." -- it checks for deeper issues
- "Gate 3: Independent verification..." -- a separate reviewer checks the work
- "Gate 4: Runtime check..." -- it tests that the code actually works
- "Gate 5: Reconciliation..." -- it cross-references all results and issues a verdict

The rasengan/sharingan cycle repeats for each phase until all phases are done. Then you see `PIPELINE_COMPLETE`.

### Running Individual Skills

You can also run each eye on its own:

```
/rinnegan    # Scan only -- produces the audit without fixing anything
/byakugan    # Analyze only -- requires rinnegan output to exist
/rasengan    # Fix only -- requires rinnegan output to exist
/sharingan   # Verify only -- works on any project at any time
```

---

## What Happens When You Run It?

Here is a typical timeline for a medium-sized project (20,000-50,000 lines of code):

| Stage | What happens | Typical duration |
|-------|-------------|-----------------|
| **Rinnegan scanning** | Every file is cataloged, scanned for mechanical violations, then analyzed in depth by multiple agents working in parallel. | 10-30 minutes |
| **Byakugan analysis** | Dependency graphs are built, findings are clustered, impact narratives and scorecards are generated. | 15-20 minutes |
| **Rasengan fixing (per phase)** | Each phase's tasks are applied one by one, with a build check after every fix. A typical project has 5-11 phases. | 30-60 minutes per phase |
| **Sharingan verification (per phase)** | Five verification gates run after each rasengan phase to catch regressions early. | 5-10 minutes per phase |

**Total for a full pipeline run:** A project with 500 findings across 8 phases typically takes 4-8 hours of autonomous work. You do not need to watch it -- just check back periodically or when it finishes.

**For larger codebases (100,000+ lines):** Rinnegan may take 30-60 minutes and rasengan phases may be longer. The pipeline handles this automatically.

---

## Understanding the Output

After the pipeline runs, you will find a `docs/audit/` directory in your project. Here is what each file means:

### The Main Reports

| File | What it is | Who should read it |
|------|-----------|-------------------|
| `master-audit.md` | The navigation hub. Executive summary, severity breakdown, links to everything else. | Everyone -- start here. |
| `layers/*.md` | Deep-dive reports for each part of your codebase (routes, services, components, etc.). Every finding with its exact location and fix. | Developers working on specific areas. |
| `cross-cutting.md` | Patterns that appear across multiple areas (e.g., "missing input validation found in 14 files across 3 layers"). | Tech leads and architects. |
| `progress.md` | A tracker showing which phases are done, in progress, or blocked. | Project managers tracking remediation. |

### The Deep Analysis (from Byakugan)

| File | What it is |
|------|-----------|
| `deep/narrative.md` | A plain-English executive report explaining what was found, how serious it is, and what the remediation plan looks like. Written for stakeholders who do not read code. |
| `deep/scorecard.md` | A compliance scorecard rating your codebase on each engineering rule category. Think of it as a report card. |
| `deep/deployment-plan.md` | A recommended rollout plan for the fixes, including risk assessment and rollback strategies. |

### The Machine-Readable Data

| File | What it is |
|------|-----------|
| `data/findings.jsonl` | Every finding as structured JSON. One line per finding. |
| `data/inventory.json` | Your project's file tree with line counts per file. |
| `data/tasks/phase-N-tasks.json` | The task lists that rasengan uses to apply fixes. One file per phase. |
| `data/phase-dag.json` | The dependency graph showing which phases must complete before others can start. |
| `data/config.json` | Metadata about the audit (date, stack detected, totals). |

### The Phase Docs

| File | What it is |
|------|-----------|
| `phases/phase-0-foundation.md` | Build and compile fixes. Always done first. |
| `phases/phase-1-security.md` | Security vulnerabilities and input validation. |
| `phases/phase-2-typing.md` | Type safety improvements. |
| `phases/phase-3-ssot-dry.md` | Eliminating duplicated logic and values. |
| `phases/phase-4-architecture.md` | Structural and naming issues. |
| `phases/phase-5-clean-code.md` | Code cleanliness (magic numbers, noise comments). |
| `phases/phase-6-performance.md` | Performance optimizations. |
| `phases/phase-7-data-integrity.md` | Hardcoded data and fake fallbacks. |
| `phases/phase-8-refactoring.md` | Larger refactors that depend on earlier phases. |
| `phases/phase-9-verification.md` | Testing and full-stack verification gaps. |
| `phases/phase-10-documentation.md` | Documentation updates. |

Not every project will have findings in every phase. Empty phases are skipped.

---

## Session Resilience

Dojutsu is built to survive interruptions. Here is what that means for you:

**If your coding agent session ends** (timeout, crash, context limit, you close the window), do not worry. All progress is saved to files on disk. Just open a new session in the same project and type `/dojutsu` again. It reads the saved state and picks up exactly where it left off. It does not redo work that was already completed.

**If you switch computers,** as long as your project directory (including `docs/audit/`) is synced (via git, Dropbox, etc.), you can continue the pipeline from any machine with dojutsu installed.

**If you want to pause and come back later,** just close your session. The state is saved after every meaningful step. There is no penalty for stopping and resuming.

**How it works under the hood:** Each eye saves a state file after every step. The dojutsu orchestrator checks these state files when it starts and figures out which eye to run next and where that eye left off. The state files are protected against accidental corruption, so the pipeline will not get confused even if something unexpected happens.

---

## FAQ

### 1. What programming languages does dojutsu support?

Dojutsu works with TypeScript/JavaScript, Python, Java, Kotlin, Go, Rust, and shell scripts. It automatically detects your project's language and framework. The 20 engineering rules it checks are language-agnostic concepts (security, typing, architecture, etc.) with language-specific detection patterns.

### 2. Will it break my code?

Rasengan verifies that your project still builds after every single fix it applies. If a fix breaks the build, it stops immediately and reports the problem. It also commits after each phase, so you can always roll back with `git revert` if needed. Your original code is never lost.

### 3. How long does a full pipeline run take?

It depends on your codebase size. A 20K-line project typically takes 4-8 hours. A 100K-line project may take 12-24 hours. You do not need to watch it -- it runs autonomously. See the timeline section above for per-stage estimates.

### 4. Can I run just the audit without fixing anything?

Yes. Type `/rinnegan` to scan your codebase and produce the full audit report. It will not change any files in your project. The output goes into `docs/audit/` and you can review it at your leisure.

### 5. Do I need to understand the engineering rules?

No. The audit reports explain every finding in plain English, including why it matters and what the fix looks like. The phase docs include explanations written for engineers with 0-2 years of experience. That said, the full list of 20 rules covers: SSOT/DRY, separation of concerns, architecture conventions, performance, security, typing, build hygiene, clean code, refactoring, documentation, real data, named constants, build verification, full-stack verification, and more.

### 6. Can I use dojutsu with a team?

Yes. The audit output is committed to your project under `docs/audit/`. Anyone on the team can read the reports. If multiple people are fixing different phases, they can coordinate using `progress.md` which tracks phase status.

### 7. What if I disagree with a finding?

You can mark individual tasks as `skipped` in the task JSON files with a reason. Rasengan will skip them and continue with the rest. The finding will still appear in reports as "skipped" so there is a record of the decision.

### 8. Does it work with monorepos?

Yes, but run it from the root of the specific service or package you want to audit. Dojutsu scans the current working directory. For a monorepo with multiple services, you would run it once per service.

### 9. What coding agents are supported?

Any agent that can run Python scripts and shell commands. This has been tested with Claude Code, Codex, OpenCode, and Gemini CLI. The skills use a standard interface (run a Python script, execute the action it outputs) that works with any agent.

### 10. Is my code sent anywhere?

Dojutsu runs entirely on your local machine. Your code is processed by whichever coding agent you are using (Claude Code, Codex, etc.) according to that agent's own privacy policy. Dojutsu itself does not send data anywhere -- it is just scripts that coordinate your agent's work.

---

## Troubleshooting

### 1. "python3 not found" during installation

Your system does not have Python 3 installed or it is not in your PATH.

**Fix:**
```bash
# macOS
brew install python@3.12

# Ubuntu/Debian
sudo apt install python3

# After installing, verify:
python3 --version
```

### 2. Skills not showing up after installation

Your coding agent has not reloaded its skill list since you installed dojutsu.

**Fix:**
Close your coding agent completely and reopen it. If that does not work, verify the symlinks exist in your agent's skill directory. For example, for Claude Code:
```bash
ls -la ~/.claude/commands/
```
You should see `rinnegan`, `byakugan`, `rasengan`, `sharingan`, and `dojutsu` as symbolic links pointing to your `~/dojutsu/skills/` directory. Other agents use their own paths (e.g., `~/.codex/skills/` for Codex, `~/.gemini/skills/` for Gemini CLI).

### 3. "No findings.jsonl found" when running rasengan or byakugan

You are trying to fix or analyze before scanning. Rasengan and byakugan need rinnegan's output to work.

**Fix:**
Run rinnegan first, or use `/dojutsu` which runs everything in the right order:
```bash
/rinnegan    # Run the scan first
# Then
/rasengan    # Now you can fix
```

### 4. Build breaks during rasengan

Rasengan applied a fix that caused a compile or lint error. It stops and reports the error.

**Fix:**
Read the error message rasengan printed. You have three options:
- Fix the build error manually, then run `/rasengan` again to continue
- Mark the problematic task as `skipped` in the phase task JSON file, then run `/rasengan` again
- Run `git revert HEAD` to undo the last phase commit, then run `/rasengan` again

### 5. Pipeline seems stuck or keeps repeating the same step

This can happen if a verification step keeps failing on the same issue.

**Fix:**
Check the state file to see where the pipeline is:
```bash
cat docs/audit/data/dojutsu-state.json
```
This shows the current eye and step. If a sharingan gate is failing repeatedly, read the error in the gate output. Common causes:
- A type error introduced by a fix (fix the type error manually)
- A test that was passing before but now fails (fix the test)
- An independent reviewer finding an issue the fixer missed (apply the suggested fix)

After resolving the issue, run `/dojutsu` again to continue.

---

## Uninstall

To remove dojutsu's skill links (your project's audit output and the dojutsu source code are not affected):

```bash
bash ~/dojutsu/uninstall.sh
```

This removes the symbolic links from your coding agent's skills directory. The dojutsu source files stay at `~/dojutsu/`. To fully remove everything:

```bash
bash ~/dojutsu/uninstall.sh
rm -rf ~/dojutsu
```

---

## Contributing

### Adding New Engineering Rules

The 20 engineering rules that rinnegan checks are defined in `skills/rinnegan/rules-reference.md`. Each rule has:
- A rule ID (R01 through R20)
- A short name
- A description of what it checks
- Severity and effort classifications
- Grep patterns for automated detection

To add a new rule:

1. Add the rule definition to `skills/rinnegan/rules-reference.md` following the existing format.
2. Add grep detection patterns to `skills/rinnegan/scripts/grep_scanner_lib.py` if the rule can be detected mechanically.
3. Add the rule to the scanner prompt in `skills/rinnegan/scanner-prompt.md` so LLM-based scanning also checks for it.
4. Map the rule to a remediation phase in `skills/rinnegan/finding-schema.md` (the phase mapping table).
5. Run the test suite to make sure nothing broke:
   ```bash
   cd ~/dojutsu
   bash run-tests.sh
   ```

### Running Tests

The test suite covers the rinnegan and rasengan pipelines (93 tests total):

```bash
cd ~/dojutsu
bash run-tests.sh
```

### Project Structure

```
~/dojutsu/
  setup.sh              # Installer
  uninstall.sh          # Uninstaller
  run-tests.sh          # Test runner
  package.json          # Project metadata
  skills/
    rinnegan/           # Scanner skill (20 engineering rules)
    byakugan/           # Analyst skill (dependency tracing, narratives)
    rasengan/           # Fixer skill (autonomous remediation)
    sharingan/          # Verifier skill (5 verification gates)
    dojutsu/            # Orchestrator skill (chains all 4 eyes)
```

---

## License

MIT
