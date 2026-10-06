// Rasengan pipeline state machine - importable library. Run repeatedly: each run checks the disk
// state and writes ONE action for the LLM.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyStr } from "@quality/py-format.ts";
import { logDispatch } from "@dojutsu/dojutsu_state.ts";
import { quickCheckTask } from "@rinnegan/revalidate-tasks.ts";
import type { PhaseTask } from "@rinnegan/revalidate-tasks.ts";

const BUILD_COMMANDS: Readonly<Record<string, string>> = {
  typescript: "bunx tsc --noEmit",
  python: "python3 -m py_compile",
  java: "mvn compile -q",
};
const SKILL_DIR = dirname(import.meta.dir);
const PHASE_FILE = /^phase-.*-tasks\.json$/;
const EXPLANATION_CHARS = 300;
const TARGET_CHARS = 200;
const MANY_PENDING_TASKS = 50;
const DISPATCH_TOKENS = 5000;
const AUTO_FIX_CONFIDENCE: readonly unknown[] = ["high", "medium"];
const REVIEW_RULE_WIDTH = 60;
const REVIEW_LISTED_FINDINGS = 15;
const REVIEW_FIX_CHARS = 120;
const RESOLVED_RESOLUTIONS: readonly unknown[] = ["applied", "already_resolved", "line-shifted"];

// The phase file as loaded: every key is kept so a rewrite loses nothing.
type PhaseData = Record<string, unknown> & { tasks: PhaseTask[] };
type Out = (text: string) => void;
export type PipelineOptions = { phase?: number; out?: Out };

type PhaseScan = {
  allPhases: { file: string; data: PhaseData }[];
  totalTasks: number;
  resolved: number;
  skipped: number;
  failed: number;
  phasesCompleted: unknown[];
  current: { file: string; data: PhaseData } | null;
};

// Python's str() of a task field, with the default a missing key gets.
function field(task: PhaseTask, key: string, fallback: string): string {
  const value = task[key];
  return value === undefined ? fallback : pyStr(value);
}

const truthy = (value: unknown): boolean => !(value === undefined || value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));
const codePoints = (text: string, length: number): string => Array.from(text).slice(0, length).join("");

function loadPhase(path: string): PhaseData {
  const data: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(data) || !Array.isArray(data["tasks"])) throw new TypeError(`${path}: expected an object with a tasks list`);
  return { ...data, tasks: data["tasks"] as PhaseTask[] };
}

const phaseOf = (data: PhaseData): unknown => data["phase"] ?? "?";

// Per-phase status from the task statuses, written to progress.md.
function updateProgressMd(auditDir: string, phases: PhaseScan["allPhases"], nowIsoText: string): void {
  const totalFindings = phases.reduce((sum, { data }) => sum + data.tasks.length, 0);
  const lines = [
    "# Audit Remediation Progress",
    "",
    `> **Updated:** ${nowIsoText} | **Total Findings:** ${totalFindings}`,
    "",
    "## Phase Status",
    "",
    "| Phase | Name | Findings | Completed | Status |",
    "|-------|------|----------|-----------|--------|",
  ];
  for (const { data } of phases) {
    const taskCount = data.tasks.length;
    const phaseName = data["phase_name"] === undefined ? `phase-${pyStr(phaseOf(data))}` : pyStr(data["phase_name"]);
    const done = data.tasks.filter((task) => task["status"] !== "pending").length;
    const status = taskCount === 0 ? "EMPTY" : done === 0 ? "NOT STARTED" : done === taskCount ? "COMPLETE" : "IN PROGRESS";
    lines.push(`| ${pyStr(phaseOf(data))} | ${phaseName} | ${taskCount} | ${taskCount === 0 ? 0 : done} | ${status} |`);
  }
  lines.push("");
  writeFileSync(join(auditDir, "progress.md"), lines.join("\n"));
}

function scanAllPhases(taskFiles: string[]): PhaseScan {
  const scan: PhaseScan = { allPhases: [], totalTasks: 0, resolved: 0, skipped: 0, failed: 0, phasesCompleted: [], current: null };
  for (const file of taskFiles) {
    const data = loadPhase(file);
    scan.allPhases.push({ file, data });
    let phasePending = 0;
    for (const task of data.tasks) {
      scan.totalTasks += 1;
      const status = task["status"] ?? "pending";
      const resolution = task["resolution"];
      if (status === "completed" && RESOLVED_RESOLUTIONS.includes(resolution)) scan.resolved += 1;
      else if (status === "skipped" || resolution === "skipped") scan.skipped += 1;
      else if (resolution === "failed") scan.failed += 1;
      if (status === "pending") phasePending += 1;
    }
    if (phasePending === 0) {
      if (!scan.phasesCompleted.includes(phaseOf(data))) scan.phasesCompleted.push(phaseOf(data));
    } else if (scan.current === null) {
      scan.current = { file, data };
    }
  }
  return scan;
}

function loadOrCreateState(stateFile: string, nowIsoText: string): Record<string, unknown> {
  if (!existsSync(stateFile)) return { started_at: nowIsoText, session_count: 1 };
  const state: unknown = JSON.parse(readTextStrict(stateFile));
  if (!isRecord(state)) throw new TypeError(`${stateFile}: expected an object`);
  const previous = state["session_count"] ?? 0;
  if (typeof previous !== "number") throw new TypeError(`${stateFile}: session_count must be a number`);
  state["session_count"] = previous + 1;
  return state;
}

function detectStack(auditDir: string): string | undefined {
  const inventoryPath = join(auditDir, "data", "inventory.json");
  if (!existsSync(inventoryPath)) return undefined;
  const inventory: unknown = JSON.parse(readTextStrict(inventoryPath));
  if (!isRecord(inventory)) throw new TypeError("inventory.json: expected an object");
  const stack = inventory["stack"] ?? "unknown";
  return typeof stack === "string" ? BUILD_COMMANDS[stack] : undefined;
}

function formatActionOutput(task: PhaseTask, taskIndex: number, phaseFileName: string, buildCommand: string | undefined): string {
  const hasTargetCode = task["target_code"] !== undefined && task["target_code"] !== null;
  const hasFixPlan = truthy(task["fix_plan"]);
  const lines: string[] = [];
  lines.push(`\nNEXT_TASK: index=${taskIndex} id=${pyStr(task["id"])}`);
  lines.push(`  File: ${pyStr(task["file"])}:${pyStr(task["line"])}`);
  lines.push(`  Rule: ${field(task, "rule", "?")} | Severity: ${field(task, "severity", "?")}`);
  lines.push(`  search_pattern: ${field(task, "search_pattern", "none")}`);
  lines.push(`  Has target_code: ${hasTargetCode ? "True" : "False"}`);
  lines.push(`  Has fix_plan: ${hasFixPlan ? "True" : "False"}`);
  lines.push("\nACTION: Fix this violation.");
  lines.push("  MODEL: sonnet");
  lines.push(`  1. Read file: ${pyStr(task["file"])}`);
  lines.push(`  2. Find pattern '${field(task, "search_pattern", "")}' near line ${pyStr(task["line"])}`);
  if (hasTargetCode) {
    lines.push("  3. Apply: Edit tool, replace with target_code");
    lines.push(`     TARGET: ${codePoints(pyStr(task["target_code"]), TARGET_CHARS)}`);
  } else if (hasFixPlan) {
    const steps = task["fix_plan"] as PhaseTask[];
    lines.push(`  3. Execute fix_plan (${steps.length} steps):`);
    for (const step of steps) lines.push(`     Step ${pyStr(step["step"])}: ${pyStr(step["action"])} ${field(step, "file", "")} -- ${field(step, "description", "")}`);
  } else {
    lines.push("  3. Read explanation and write appropriate fix");
  }
  lines.push("  4. Verify fix present in file");
  lines.push(`  5. Update ${phaseFileName} index ${taskIndex}: set status='completed', resolution='applied', completed_at='<current ISO timestamp>'`);
  lines.push(
    buildCommand === undefined
      ? "  6. Verify build: run the project build command and fix any errors before proceeding"
      : `  6. Verify build: run \`${buildCommand}\` and fix any errors before proceeding`,
  );
  lines.push("  7. Run this script again for next task");
  lines.push(`\n  EXPLANATION: ${codePoints(field(task, "explanation", "none"), EXPLANATION_CHARS)}`);
  return lines.join("\n");
}

// Puts each file's pending tasks in descending line order, in the slots they hold, so an edit
// never shifts the line of a task still pending in the same file. Returns the files reordered.
function reorderSameFileBottomUp(tasks: PhaseTask[]): string[] {
  const slots = new Map<string, number[]>();
  tasks.forEach((task, index) => {
    if (task["status"] !== "pending") return;
    const file = pyStr(task["file"]);
    slots.set(file, [...(slots.get(file) ?? []), index]);
  });
  const changed: string[] = [];
  for (const [file, indexes] of slots) {
    const ordered = indexes.map((index) => tasks[index]).sort((a, b) => lineOf(b) - lineOf(a));
    if (indexes.some((index, position) => tasks[index] !== ordered[position])) {
      indexes.forEach((index, position) => {
        const task = ordered[position];
        if (task !== undefined) tasks[index] = task;
      });
      changed.push(file);
    }
  }
  return changed;
}

function lineOf(task: PhaseTask | undefined): number {
  const line = task?.["line"];
  if (typeof line !== "number") throw new TypeError("task line must be a number");
  return line;
}

function skipTask(task: PhaseTask, note: string): void {
  task["status"] = "completed";
  task["resolution"] = "skipped";
  task["notes"] = note;
}

// The recorded decisions for LOW findings; a file that cannot be used is reported and ignored.
function loadHumanDecisions(path: string, out: Out): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const loaded: unknown = JSON.parse(readTextStrict(path));
    if (isRecord(loaded)) return loaded;
    out("  WARNING: human-decisions.json is not a dict. Ignoring.\n");
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code === undefined) throw error;
    out(`  WARNING: Failed to parse human-decisions.json (${(error as Error).message}). Ignoring.\n`);
  }
  return {};
}

function lowConfidenceReview(undecided: PhaseTask[], decisionsPath: string): string {
  const rule = "=".repeat(REVIEW_RULE_WIDTH);
  const lines = ["", rule, `LOW-CONFIDENCE REVIEW: ${undecided.length} findings need your input`, rule, ""];
  undecided.slice(0, REVIEW_LISTED_FINDINGS).forEach((task, index) => {
    lines.push(`[${index + 1}/${undecided.length}] ${field(task, "id", "?")} [${field(task, "rule", "")}] ${pyStr(task["file"])}:${pyStr(task["line"])}`);
    lines.push(`  ${field(task, "description", "")}`);
    lines.push(`  Confidence: LOW — ${field(task, "confidence_reason", "no reason given")}`);
    if (truthy(task["target_code"])) lines.push(`  Fix: ${codePoints(pyStr(task["target_code"]), REVIEW_FIX_CHARS)}`);
    lines.push("");
  });
  if (undecided.length > REVIEW_LISTED_FINDINGS) lines.push(`  ... and ${undecided.length - REVIEW_LISTED_FINDINGS} more`, "");
  lines.push("ACTION: Review LOW-confidence findings and record decisions.");
  lines.push(`  Write to: ${decisionsPath}`);
  lines.push('  Format: {"decided_ids": {"FINDING-ID": "fix|skip"}, "bulk_rules": {"R04": "skip-all-low"}}');
  lines.push("  Then run this script again to apply decisions and continue.");
  return lines.join("\n") + "\n";
}

const phaseSortKey = (name: string): number => Number(name.split("-")[1]);

export function runPipeline(projectDir: string, options: PipelineOptions = {}): number {
  const out: Out = options.out ?? ((text) => void process.stdout.write(text));
  const auditDir = join(projectDir, "docs", "audit");
  const tasksDir = join(auditDir, "data", "tasks");
  const taskFiles = (existsSync(tasksDir) ? readdirSync(tasksDir) : [])
    .filter((name) => PHASE_FILE.test(name))
    .sort((a, b) => phaseSortKey(a) - phaseSortKey(b))
    .map((name) => join(tasksDir, name));

  if (taskFiles.length === 0) {
    out("ERROR: No task files found. Run /rinnegan first.\n");
    out(`Expected: ${auditDir}/data/tasks/phase-*-tasks.json\n`);
    return 1;
  }

  const buildCommand = detectStack(auditDir);
  const scan = scanAllPhases(taskFiles);
  let current = scan.current;
  let phaseComplete = false;
  if (options.phase !== undefined) {
    const requested = scan.allPhases.find(({ data }) => data["phase"] === options.phase);
    if (requested !== undefined && !scan.phasesCompleted.includes(options.phase)) current = requested;
    else phaseComplete = true;
  }

  const nowText = nowIso();
  const stateFile = join(auditDir, "data", "rasengan-state.json");
  const state = loadOrCreateState(stateFile, nowText);
  const nextTaskId = current?.data.tasks.find((task) => task["status"] === "pending")?.["id"] ?? null;
  state["last_updated"] = nowText;
  state["current_phase"] = current === null ? null : phaseOf(current.data);
  state["current_task_id"] = nextTaskId;
  state["phases_completed"] = scan.phasesCompleted.filter((phase): phase is number => typeof phase === "number").sort((a, b) => a - b);
  state["phases_pending"] = scan.allPhases
    .map(({ data }) => data["phase"])
    .filter((phase): phase is number => typeof phase === "number" && !scan.phasesCompleted.includes(phase))
    .sort((a, b) => a - b);
  state["total_tasks"] = scan.totalTasks;
  state["tasks_resolved"] = scan.resolved;
  state["tasks_skipped"] = scan.skipped;
  state["tasks_failed"] = scan.failed;
  state["status"] = current === null ? "completed" : "in_progress";
  if (!("started_at" in state)) state["started_at"] = nowText;
  writeFileSync(stateFile, dumpJson(state));
  updateProgressMd(auditDir, scan.allPhases, nowText);

  out(`AUDIT_DIR: ${auditDir}\n`);
  out(`SKILL_DIR: ${SKILL_DIR}\n`);
  out(`PROJECT_DIR: ${projectDir}\n`);

  if (phaseComplete) {
    out(`\nPHASE_COMPLETE: ${options.phase}\n`);
    out(`  No pending tasks in phase ${options.phase}.\n`);
    out(`\nACTION: Commit the phase's fixes (fix(phase-${options.phase}): [phase-name] - X applied), then run this script again.\n`);
    return 0;
  }

  if (current === null) {
    out("\nALL_PHASES_COMPLETE\n");
    out(`  Total: ${scan.totalTasks}, Resolved: ${scan.resolved}\n`);
    out(`  Skipped: ${scan.skipped}, Failed: ${scan.failed}\n`);
    out("\nACTION: Final verification and report.\n");
    out(`  Run: ${SKILL_DIR}/verify-phase.sh on each completed phase\n`);
    out(`  Read: ${SKILL_DIR}/report-generator-prompt.md for report structure\n`);
    out(`  Write: ${auditDir}/data/rasengan-results.json\n`);
    return 0;
  }
  const tasks = current.data.tasks;
  const reordered = reorderSameFileBottomUp(tasks);
  if (reordered.length > 0) {
    writeFileSync(current.file, dumpJson(current.data));
    for (const file of reordered) out(`  AUTO_REORDERED: ${file} (same-file tasks now bottom-up)\n`);
  }
  const allPending = tasks.filter((task) => task["status"] === "pending");
  const completed = tasks.filter((task) => task["status"] === "completed");
  const failed = tasks.filter((task) => task["resolution"] === "failed");

  // HIGH and MEDIUM confidence tasks are fixed automatically; LOW ones wait for a human decision.
  const autoFixPending = allPending.filter((task) => AUTO_FIX_CONFIDENCE.includes(("confidence" in task ? task["confidence"] : "high")));
  const lowPending = allPending.filter((task) => task["confidence"] === "low");

  const decisionsPath = join(auditDir, "data", "human-decisions.json");
  const decisions = loadHumanDecisions(decisionsPath, out);
  const bulkRules = decisions["bulk_rules"] ?? {};
  const decidedIds = decisions["decided_ids"] ?? {};
  if (!isRecord(bulkRules) || !isRecord(decidedIds)) throw new TypeError("human-decisions.json: bulk_rules and decided_ids must be objects");
  for (const task of lowPending) {
    const id = field(task, "id", "");
    const rule = field(task, "rule", "");
    if (Object.hasOwn(decidedIds, id)) {
      const action = decidedIds[id];
      if (action === "skip") skipTask(task, "Skipped by human decision");
      else if (action === "fix") autoFixPending.push(task);
    } else if (Object.hasOwn(bulkRules, rule)) {
      const action = bulkRules[rule];
      if (action === "skip" || action === "skip-all-low") skipTask(task, `Skipped by bulk decision: skip-all-${rule}-LOW`);
      else if (action === "fix" || action === "fix-all-low") autoFixPending.push(task);
    }
  }
  if (lowPending.some((task) => task["status"] === "completed" && field(task, "notes", "").startsWith("Skipped by"))) {
    writeFileSync(current.file, dumpJson(current.data));
  }

  const undecidedLow = allPending.filter(
    (task) => task["confidence"] === "low" && task["status"] === "pending" && !Object.hasOwn(decidedIds, field(task, "id", "")) && !Object.hasOwn(bulkRules, field(task, "rule", "")),
  );
  if (autoFixPending.length === 0 && undecidedLow.length > 0) {
    out(lowConfidenceReview(undecidedLow, decisionsPath));
    return 0;
  }

  const pending = autoFixPending;
  out(`\nPHASE: ${pyStr(phaseOf(current.data))} (${field(current.data, "phase_name", "unknown")})\n`);
  out(`  Total: ${tasks.length}, Pending: ${pending.length}, Done: ${completed.length}, Failed: ${failed.length}\n`);
  out(`  File: ${current.file}\n`);
  if (pending.length > MANY_PENDING_TASKS) out(`\n  WARNING: ${pending.length} tasks. Process first 30, then commit and pause.\n`);

  const nextTask = pending[0];
  if (nextTask === undefined) {
    out(`  DECISIONS_APPLIED: no task is left to fix in phase ${pyStr(phaseOf(current.data))}\n`);
    out("  Run this script again for the next task.\n");
    return 0;
  }
  const taskIndex = tasks.indexOf(nextTask);

  // Deleting a file needs the operator's approval of the exact path (R28), so a fix_plan with a
  // delete step is never offered as an autonomous fix.
  const fixPlan = nextTask["fix_plan"];
  const deletePaths = (Array.isArray(fixPlan) ? (fixPlan as unknown[]) : [])
    .filter((step): step is PhaseTask => isRecord(step) && step["action"] === "delete")
    .map((step) => field(step, "file", ""));
  if (deletePaths.length > 0) {
    nextTask["status"] = "skipped";
    nextTask["resolution"] = "skipped";
    nextTask["notes"] = `delete needs operator approval: ${deletePaths.join(", ")}`;
    writeFileSync(current.file, dumpJson(current.data));
    out(`  TASK_SKIPPED: ${field(nextTask, "id", "?")} — fix_plan deletes ${deletePaths.join(", ")}; needs operator approval\n`);
    out("  Run this script again for the next task.\n");
    return 0;
  }

  // Per-task revalidation: the code still has to be where the task cites it.
  try {
    if (!quickCheckTask(nextTask, projectDir)) {
      writeFileSync(current.file, dumpJson(current.data));
      out(`  TASK_SKIPPED: ${field(nextTask, "id", "?")} — code no longer present (fixed by earlier phase)\n`);
      out("  Run this script again for the next task.\n");
      return 0;
    }
  } catch (error) {
    out(`  WARNING: Task revalidation failed (${error instanceof Error ? error.message : String(error)}). Proceeding with unvalidated task.\n`);
  }
  logDispatch(projectDir, `fix_${field(nextTask, "id", "?")}`, DISPATCH_TOKENS, "sonnet");
  out(formatActionOutput(nextTask, taskIndex, current.file.slice(current.file.lastIndexOf("/") + 1), buildCommand));
  out("\n");
  return 0;
}
