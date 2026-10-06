#!/usr/bin/env bun
// Rasengan pipeline state machine. Run repeatedly: each run checks the disk state and writes
// ONE action for the LLM.
// Usage: run-pipeline.ts <project_dir> [--phase N]
import { parseIntArg, usageError } from "@quality/cli.ts";
import { runPipeline } from "@rasengan/run_pipeline_lib.ts";

const PROG = "rasengan";
const USAGE = `usage: ${PROG} [-h] [--phase PHASE] project_dir`;

const positional: string[] = [];
let phase: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? "";
  if (arg === "-h" || arg === "--help") {
    console.log(`${USAGE}\n\nFix audit findings, one task per run.`);
    process.exit(0);
  } else if (arg === "--phase" || arg.startsWith("--phase=")) {
    const value = arg === "--phase" ? args[(i += 1)] : arg.slice("--phase=".length);
    if (value === undefined) usageError(USAGE, PROG, "argument --phase: expected one argument");
    phase = parseIntArg(value);
    if (phase === undefined) usageError(USAGE, PROG, `argument --phase: invalid int value: '${value}'`);
  } else {
    positional.push(arg);
  }
}
const [projectDir, ...extra] = positional;
if (projectDir === undefined) usageError(USAGE, PROG, "the following arguments are required: project_dir");
if (extra.length > 0) usageError(USAGE, PROG, `unrecognized arguments: ${extra.join(" ")}`);

process.exitCode = runPipeline(projectDir, phase === undefined ? {} : { phase });
