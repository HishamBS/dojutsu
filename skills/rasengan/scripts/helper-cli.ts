#!/usr/bin/env bun
// The JSON-reading bodies of rasengan's shell entrypoints. Every argument arrives as an argv
// element, so a path or a command never passes through a code string.
// Usage: helper-cli.ts verify-phase <phase_tasks_json>
//        helper-cli.ts track-progress <audit_dir>
//        helper-cli.ts commit-message <phase_tasks_json>
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyStr } from "@quality/py-format.ts";

export type HelperCommand = "verify-phase" | "track-progress" | "commit-message";

const PHASE_FILE = /^phase-.*-tasks\.json$/;
const PHASE_LABEL = /^phase-([0-9]*)-.*/;
const REQUIRED_PHASE_FIELDS: readonly string[] = ["phase", "phase_name", "tasks"];
const COMMIT_PARTS: readonly (readonly [resolution: string, label: string])[] = [
  ["applied", "applied"],
  ["line-shifted", "line-shifted"],
  ["already_resolved", "already-resolved"],
  ["skipped", "skipped"],
  ["failed", "failed"],
];
const COLUMN_WIDTHS = [5, 5, 7, 10, 9, 8, 7] as const;

// $(...) drops the trailing newlines of what a command printed.
const dropTrailingNewlines = (text: string): string => text.replace(/\n+$/, "");
// tr -d '[:space:]'
const dropSpace = (text: string): string => text.replace(/[ \t\n\v\f\r]/g, "");

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readTextStrict(path));
}

// Runs the phase's verification command and compares its whitespace-free output (stdout and
// stderr together) with the expected one. A command that exits non-zero ends the run with its
// exit status and no verdict line; unreadable or malformed phase JSON ends it with status 1.
function verifyPhase(phaseJson: string): number {
  if (!existsSync(phaseJson) || !statSync(phaseJson).isFile()) {
    say(`FAIL: ${phaseJson} not found`);
    return 1;
  }
  let data: unknown;
  try {
    data = readJson(phaseJson);
  } catch {
    return 1;
  }
  if (!isRecord(data)) return 1;
  const verification = data["verification"] ?? {};
  if (!isRecord(verification)) return 1;
  const command = dropTrailingNewlines(pyStr(verification["command"] ?? ""));
  const expected = dropTrailingNewlines(pyStr(verification["expected"] ?? ""));
  if (command === "") {
    say(`WARN: No verification command in ${phaseJson}`);
    return 0;
  }

  say(`Running: ${command}`);
  const result = Bun.spawnSync(["sh", "-c", 'exec bash -c "$1" 2>&1', "sh", command], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return result.exitCode;
  const actual = dropSpace(result.stdout.toString());
  if (actual === dropSpace(expected)) {
    say(`PASS: Expected '${expected}', got '${actual}'`);
    return 0;
  }
  say(`FAIL: Expected '${expected}', got '${actual}'`);
  return 1;
}

type PhaseStats = { total: number; pending: number; inProgress: number; completed: number; resolved: number; skipped: number; failed: number };
const ZERO_STATS: PhaseStats = { total: 0, pending: 0, inProgress: 0, completed: 0, resolved: 0, skipped: 0, failed: 0 };

// The task counts of one phase file; a file that cannot be read as phase tasks counts as zeros.
function phaseStats(path: string): PhaseStats {
  let data: unknown;
  try {
    data = readJson(path);
  } catch {
    return ZERO_STATS;
  }
  if (!isRecord(data)) return ZERO_STATS;
  const raw = data["tasks"] ?? [];
  if (!Array.isArray(raw) || !raw.every(isRecord)) return ZERO_STATS;
  const tasks: Record<string, unknown>[] = raw;
  const statusOf = (task: Record<string, unknown>): unknown => ("status" in task ? task["status"] : "pending");
  const countStatus = (value: string): number => tasks.filter((task) => statusOf(task) === value).length;
  const countResolution = (value: string): number => tasks.filter((task) => task["resolution"] === value).length;
  return {
    total: tasks.length,
    pending: countStatus("pending"),
    inProgress: countStatus("in_progress"),
    completed: countStatus("completed"),
    resolved: countResolution("already_resolved"),
    skipped: countResolution("skipped"),
    failed: countResolution("failed"),
  };
}

const padRight = (value: string | number, width: number): string => String(value).padEnd(width);

// One row per phase file (in file-name order) and how many tasks are resolved overall.
function trackProgress(auditDir: string): number {
  const tasksDir = join(auditDir, "data", "tasks");
  if (!existsSync(tasksDir) || !statSync(tasksDir).isDirectory()) {
    say(`No tasks directory at ${tasksDir}`);
    return 1;
  }
  say("Phase | Total | Pending | InProgress | Completed | Resolved | Skipped | Failed");
  say("------|-------|---------|------------|-----------|----------|---------|-------");
  let totalAll = 0;
  let completedAll = 0;
  for (const name of readdirSync(tasksDir).filter((file) => PHASE_FILE.test(file)).sort()) {
    const path = join(tasksDir, name);
    if (!statSync(path).isFile()) continue;
    const phase = PHASE_LABEL.test(name) ? name.replace(PHASE_LABEL, "$1") : name;
    const stats = phaseStats(path);
    const cells = [phase, stats.total, stats.pending, stats.inProgress, stats.completed, stats.resolved, stats.skipped].map((cell, index) => padRight(cell, COLUMN_WIDTHS[index] ?? 0));
    say(`  ${cells.join(" | ")} | ${stats.failed}`);
    totalAll += stats.total;
    completedAll += stats.completed + stats.resolved;
  }
  say("");
  say(`Total: ${completedAll}/${totalAll} tasks resolved`);
  return 0;
}

// A commit message from a phase file's resolutions. A missing file, malformed JSON or tasks that
// cannot be counted each print their own generic message; the exit status is always 0.
function commitMessage(phaseJson: string): number {
  if (!existsSync(phaseJson) || !statSync(phaseJson).isFile()) {
    say("fix: phase completion");
    return 0;
  }
  let data: unknown;
  try {
    data = readJson(phaseJson);
  } catch {
    data = undefined;
  }
  if (!isRecord(data) || !REQUIRED_PHASE_FIELDS.every((field) => field in data)) {
    say("fix: phase completion (malformed JSON)");
    return 0;
  }
  const tasks = data["tasks"];
  const countable = Array.isArray(tasks) ? tasks.every(isRecord) : (isRecord(tasks) && Object.keys(tasks).length === 0) || tasks === "";
  if (!countable) {
    say("fix: phase completion");
    return 0;
  }
  const records = Array.isArray(tasks) ? (tasks as Record<string, unknown>[]) : [];
  const parts = COMMIT_PARTS.map(([resolution, label]) => [records.filter((task) => task["resolution"] === resolution).length, label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  say(`fix(phase-${pyStr(data["phase"])}): ${pyStr(data["phase_name"])} - ${parts.length > 0 ? parts.join(", ") : "no changes"}`);
  return 0;
}

export function runHelper(command: HelperCommand, args: string[]): Promise<number> {
  const [first = ""] = args;
  switch (command) {
    case "verify-phase":
      return Promise.resolve(verifyPhase(first));
    case "track-progress":
      return Promise.resolve(trackProgress(first));
    case "commit-message":
      return Promise.resolve(commitMessage(first));
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "verify-phase" && command !== "track-progress" && command !== "commit-message") {
    console.error("Usage: helper-cli.ts verify-phase <phase_tasks_json> | track-progress <audit_dir> | commit-message <phase_tasks_json>");
    process.exit(2);
  }
  process.exitCode = await runHelper(command, args);
}
