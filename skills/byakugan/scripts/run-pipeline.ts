#!/usr/bin/env bun
// Byakugan pipeline state machine. Run repeatedly: each run checks the disk state and writes
// ONE action for the LLM.
// Usage: run-pipeline.ts <project_dir>
import { runPipeline } from "@byakugan/run_pipeline_lib.ts";

const [projectDir] = process.argv.slice(2);
if (projectDir === undefined) {
  console.log("Usage: run-pipeline.ts <project_dir>");
  process.exit(1);
}
process.exitCode = await runPipeline(projectDir);
