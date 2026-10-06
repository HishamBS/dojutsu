#!/usr/bin/env bun
// Revalidate pending tasks against live source code. Deterministic, zero tokens.
// Called by dojutsu (between phases, at startup) and rasengan (before each task).
//
// Usage:
//   revalidate-tasks.ts <project_dir>                 # revalidate ALL pending tasks
//   revalidate-tasks.ts <project_dir> --phase 5       # revalidate only phase 5
//   revalidate-tasks.ts <project_dir> --task BLD-042  # revalidate one task
//   revalidate-tasks.ts <project_dir> --changed-only  # only tasks in files modified since HEAD~1
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";

export type PhaseTask = Record<string, unknown>;
export type RevalidationStats = {
  valid: number;
  line_updated: number;
  already_resolved: number;
  needs_rescan: number;
  skipped: number;
  error?: string;
};
export type RevalidationOptions = { phaseNum?: number; taskId?: string; changedOnly?: boolean };

type TaskResult = "valid" | "line_updated" | "already_resolved" | "needs_rescan" | "skipped";
type CodeStatus = "exact" | "nearby" | "file_wide" | "not_found" | "file_missing";

// Code shorter than this cannot be told from noise, so the task is trusted as it stands.
const MIN_VALIDATABLE_CODE_LENGTH = 5;
const NEARBY_WINDOW = 20;
const LARGE_SHIFT_LINES = 50;
const PHASE_FILE = /^phase-.*-tasks\.json$/;
const STAT_KEYS = ["valid", "line_updated", "already_resolved", "needs_rescan", "skipped"] as const;

const emptyStats = (): RevalidationStats => ({ valid: 0, line_updated: 0, already_resolved: 0, needs_rescan: 0, skipped: 0 });

function strValue(task: PhaseTask, key: string, fallback = ""): string {
  const value = task[key];
  return typeof value === "string" ? value : fallback;
}

// Files modified since a git ref; none when git cannot say.
function getModifiedFiles(projectDir: string, since = "HEAD~1"): Set<string> {
  const result = Bun.spawnSync(["git", "diff", "--name-only", since], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return new Set();
  const text = result.stdout.toString().trim();
  return text === "" ? new Set() : new Set(text.split("\n"));
}

// readlines(): universal newlines, no empty trailing element.
function readLines(path: string): string[] | undefined {
  let text: string;
  try {
    text = readTextStrict(path);
  } catch {
    return undefined;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findCodeInFile(filePath: string, currentCode: string, citedValue: unknown): { status: CodeStatus; line: number | null } {
  if (!existsSync(filePath)) return { status: "file_missing", line: null };
  const lines = readLines(filePath);
  if (lines === undefined) return { status: "file_missing", line: null };

  const first = (currentCode.trim().split("\n")[0] ?? "").trim();
  if (first.length < MIN_VALIDATABLE_CODE_LENGTH) return { status: "exact", line: typeof citedValue === "number" ? citedValue : null };
  if (typeof citedValue !== "number") throw new TypeError(`cited line must be a number, got ${JSON.stringify(citedValue)}`);
  const cited = citedValue;
  if (cited > 0 && cited <= lines.length && (lines[cited - 1] ?? "").includes(first)) return { status: "exact", line: cited };

  for (let offset = 1; offset <= NEARBY_WINDOW; offset += 1) {
    for (const check of [cited - 1 + offset, cited - 1 - offset]) {
      if (check >= 0 && check < lines.length && (lines[check] ?? "").includes(first)) return { status: "nearby", line: check + 1 };
    }
  }
  const index = lines.findIndex((line) => line.includes(first));
  return index >= 0 ? { status: "file_wide", line: index + 1 } : { status: "not_found", line: null };
}

function revalidateTask(task: PhaseTask, projectDir: string): TaskResult {
  if (task["status"] !== "pending") return "skipped";
  const file = strValue(task, "file");
  const filePath = isAbsolute(file) ? file : join(projectDir, file);
  const currentCode = strValue(task, "current_code").trim();
  const citedValue = task["line"] ?? 0;
  if (currentCode === "" || ((currentCode.split("\n")[0] ?? "").trim().length < MIN_VALIDATABLE_CODE_LENGTH)) return "valid";

  const { status, line } = findCodeInFile(filePath, currentCode, citedValue);
  if (status === "file_missing") {
    task["status"] = "completed";
    task["resolution"] = "already_resolved";
    task["notes"] = "File no longer exists";
    return "already_resolved";
  }
  if (status === "not_found") {
    task["status"] = "completed";
    task["resolution"] = "already_resolved";
    task["notes"] = "Code no longer present in file (likely fixed by earlier phase)";
    return "already_resolved";
  }
  if (status === "exact") return "valid";

  const cited = typeof citedValue === "number" ? citedValue : 0;
  const shift = line ? Math.abs(line - cited) : 0;
  task["original_line"] = cited;
  task["line"] = line;
  task["line_shifted"] = true;
  if (shift > LARGE_SHIFT_LINES) {
    task["notes"] = `Line shifted by ${shift} — verify fix still applies`;
    return "needs_rescan";
  }
  return "line_updated";
}

function revalidatePhaseFile(phaseFile: string, projectDir: string, changedFiles: ReadonlySet<string> | null, targetTaskId: string | undefined): RevalidationStats {
  const data: unknown = JSON.parse(readTextStrict(phaseFile));
  if (!isRecord(data)) throw new TypeError(`${phaseFile}: expected an object`);
  const stats = emptyStats();
  let modified = false;
  const tasks = data["tasks"] ?? [];
  if (!Array.isArray(tasks)) throw new TypeError(`${phaseFile}: tasks must be a list`);
  for (const task of tasks as PhaseTask[]) {
    if (task["status"] !== "pending") {
      stats.skipped += 1;
      continue;
    }
    if (changedFiles !== null && !changedFiles.has(strValue(task, "file"))) {
      stats.skipped += 1;
      continue;
    }
    if (targetTaskId !== undefined && task["id"] !== targetTaskId) {
      stats.skipped += 1;
      continue;
    }
    const result = revalidateTask(task, projectDir);
    stats[result] += 1;
    if (result !== "valid" && result !== "skipped") modified = true;
  }
  if (modified) writeFileSync(phaseFile, dumpJson(data));
  return stats;
}

function phaseNumber(fileName: string): number {
  const part = fileName.split("-")[1] ?? "";
  if (!/^[+-]?\d+$/.test(part.trim())) throw new TypeError(`invalid literal for int(): ${JSON.stringify(part)}`);
  return Number(part);
}

// "{'valid': 1, 'line_updated': 2}", the way the retired script printed its dict.
function pyDictRepr(counts: Record<string, number>): string {
  return `{${Object.entries(counts).map(([key, value]) => `'${key}': ${value}`).join(", ")}}`;
}

// Revalidates every phase task file (or the selected phase/task/changed files); prints one line per phase with activity.
export function revalidateAll(projectDir: string, options: RevalidationOptions = {}): RevalidationStats {
  const tasksDir = join(projectDir, "docs", "audit", "data", "tasks");
  const matches = (name: string): boolean => (options.phaseNum === undefined ? PHASE_FILE.test(name) : name === `phase-${options.phaseNum}-tasks.json`);
  const taskFiles = existsSync(tasksDir) ? readdirSync(tasksDir).filter(matches).sort((a, b) => phaseNumber(a) - phaseNumber(b)) : [];
  if (taskFiles.length === 0) return { ...emptyStats(), error: "No task files found" };

  const changedFiles = options.changedOnly ? getModifiedFiles(projectDir) : null;
  const total = emptyStats();
  for (const name of taskFiles) {
    const stats = revalidatePhaseFile(join(tasksDir, name), projectDir, changedFiles, options.taskId);
    for (const key of STAT_KEYS) total[key] += stats[key];
    const active = Object.fromEntries(STAT_KEYS.filter((key) => key !== "skipped" && stats[key] > 0).map((key) => [key, stats[key]]));
    if (Object.keys(active).length > 0) console.log(`  Phase ${name.split("-")[1] ?? ""}: ${pyDictRepr(active)}`);
  }
  return total;
}

// Quick pre-fix validation for rasengan: true while the task is still worth fixing.
export function quickCheckTask(task: PhaseTask, projectDir: string): boolean {
  if (task["status"] !== "pending") return false;
  const result = revalidateTask(task, projectDir);
  return result === "valid" || result === "line_updated";
}

function parseIntStrict(text: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new TypeError(`invalid literal for int(): ${JSON.stringify(text)}`);
  return Number(text);
}

if (import.meta.main) {
  const [projectDir, ...args] = process.argv.slice(2);
  if (projectDir === undefined) {
    console.log("Usage: revalidate-tasks.ts <project_dir> [--phase N] [--task ID] [--changed-only]");
    process.exit(1);
  }
  const options: RevalidationOptions = {};
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--phase" && next !== undefined) {
      options.phaseNum = parseIntStrict(next);
      i += 2;
    } else if (arg === "--task" && next !== undefined) {
      options.taskId = next;
      i += 2;
    } else if (arg === "--changed-only") {
      options.changedOnly = true;
      i += 1;
    } else {
      i += 1;
    }
  }

  console.log(`Revalidating tasks in ${projectDir}`);
  if (options.phaseNum !== undefined) console.log(`  Phase: ${options.phaseNum}`);
  if (options.taskId !== undefined) console.log(`  Task: ${options.taskId}`);
  if (options.changedOnly) console.log("  Changed files only (since HEAD~1)");

  const stats = revalidateAll(projectDir, options);
  console.log("\nResults:");
  console.log(`  Valid (no change):     ${stats.valid}`);
  console.log(`  Line updated:         ${stats.line_updated}`);
  console.log(`  Already resolved:     ${stats.already_resolved}`);
  console.log(`  Needs rescan:         ${stats.needs_rescan}`);
  console.log(`  Skipped (done/other): ${stats.skipped}`);
  if (stats.already_resolved > 0) console.log(`\n  ${stats.already_resolved} tasks removed (already fixed by earlier phases)`);
}
