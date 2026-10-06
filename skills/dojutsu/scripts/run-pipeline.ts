#!/usr/bin/env bun
// Dojutsu pipeline orchestrator.
// Usage:
//   run-pipeline.ts <project_dir>                    # audit only (default)
//   run-pipeline.ts <project_dir> --fix              # audit + fix (interactive)
//   run-pipeline.ts <project_dir> --fix --auto       # fully autonomous
//   run-pipeline.ts <project_dir> --fix --phases 0,1 # fix specific phases
//   run-pipeline.ts <project_dir> --resume           # resume from saved state
//   run-pipeline.ts <project_dir> --status           # show state
//   run-pipeline.ts <project_dir> --report           # regenerate reports
//   run-pipeline.ts <project_dir> --clean            # delete docs/audit/ (operator request only)
import { resolve } from "node:path";
import { parseIntArg, usageError } from "@quality/cli.ts";
import type { DojutsuFlags } from "@dojutsu/dojutsu_state.ts";
import { runPipeline } from "@dojutsu/run_pipeline_lib.ts";

const PROG = "dojutsu";
const USAGE = [
  `usage: ${PROG} [-h] [--status | --report | --clean] [--fix] [--phases PHASES]`,
  "               [--auto | --interactive] [--resume]",
  "               project_dir",
].join("\n");
const INFO_FLAGS: readonly string[] = ["--status", "--report", "--clean"];
const APPROVAL_FLAGS: readonly string[] = ["--auto", "--interactive"];

function fail(message: string): never {
  return usageError(USAGE, PROG, message);
}

const positional: string[] = [];
const seen = new Set<string>();
let phasesText: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? "";
  if (arg === "-h" || arg === "--help") {
    console.log(`${USAGE}\n\nAudit, analyze, fix, verify.`);
    process.exit(0);
  }
  const [flag = "", inline] = arg.startsWith("--phases=") ? ["--phases", arg.slice("--phases=".length)] : [arg];
  if (flag === "--phases") {
    phasesText = inline ?? args[(i += 1)];
    if (phasesText === undefined) fail("argument --phases: expected one argument");
  } else if (["--fix", "--resume", ...INFO_FLAGS, ...APPROVAL_FLAGS].includes(flag)) {
    for (const group of [INFO_FLAGS, APPROVAL_FLAGS]) {
      const conflict = group.find((other) => other !== flag && seen.has(other));
      if (group.includes(flag) && conflict !== undefined) fail(`argument ${flag}: not allowed with argument ${conflict}`);
    }
    seen.add(flag);
  } else {
    positional.push(arg);
  }
}
const [projectDir, ...extra] = positional;
if (projectDir === undefined) fail("the following arguments are required: project_dir");
if (extra.length > 0) fail(`unrecognized arguments: ${extra.join(" ")}`);
if (phasesText !== undefined && phasesText !== "" && !seen.has("--fix")) fail("--phases requires --fix");
if (seen.has("--auto") && !seen.has("--fix")) fail("--auto requires --fix");

const phases = phasesText
  ? phasesText.split(",").map((part) => {
      const phase = parseIntArg(part);
      if (phase === undefined) throw new Error(`invalid literal for int() with base 10: '${part.trim()}'`);
      return phase;
    })
  : null;
const flags: DojutsuFlags = {
  mode: seen.has("--fix") ? "fix" : "audit",
  phases,
  approval: seen.has("--auto") ? "auto" : "interactive",
  resume: seen.has("--resume"),
  status: seen.has("--status"),
  report: seen.has("--report"),
  clean: seen.has("--clean"),
};
process.exitCode = await runPipeline(resolve(projectDir), flags);
