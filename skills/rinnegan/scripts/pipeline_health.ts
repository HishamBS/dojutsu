// Generate the pipeline health report after tool scanning: data/pipeline-health.json carries
// structured metrics about tool execution results, finding counts and project size.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso } from "@quality/py-format.ts";
import type { ToolResult } from "@rinnegan/tool_runner.ts";

export type PipelineHealth = {
  timestamp: string;
  tools_available: number;
  tools_succeeded: number;
  tools_skipped: number;
  tools_failed: number;
  tools_timed_out: number;
  total_deterministic_findings: number;
  total_files: number;
  total_loc: number;
  tool_results: { tool: string; status: string; findings: number; duration_ms: number; error?: string }[];
};

type ProjectSize = { totalFiles: number; totalLoc: number };

// File count and LOC from the inventory; an absent or unparsable inventory leaves them at zero.
function readProjectSize(auditDir: string): ProjectSize {
  const path = join(auditDir, "data", "inventory.json");
  if (!existsSync(path) || !statSync(path).isFile()) return { totalFiles: 0, totalLoc: 0 };
  let inventory: unknown;
  try {
    inventory = JSON.parse(readTextStrict(path));
  } catch (error) {
    if (error instanceof SyntaxError) return { totalFiles: 0, totalLoc: 0 };
    throw error;
  }
  if (!isRecord(inventory)) throw new TypeError(`${path}: expected a JSON object`);
  const files = inventory["files"];
  const loc = inventory["total_loc"];
  return { totalFiles: Array.isArray(files) ? files.length : 0, totalLoc: typeof loc === "number" ? loc : 0 };
}

const countStatus = (results: readonly ToolResult[], status: ToolResult["status"]): number => results.filter((result) => result.status === status).length;

// Write data/pipeline-health.json and return the report that was written.
export function writeHealthReport(auditDir: string, results: readonly ToolResult[]): PipelineHealth {
  const { totalFiles, totalLoc } = readProjectSize(auditDir);
  const report: PipelineHealth = {
    timestamp: nowIso(),
    tools_available: results.length,
    tools_succeeded: countStatus(results, "success"),
    tools_skipped: countStatus(results, "skipped"),
    tools_failed: countStatus(results, "failed"),
    tools_timed_out: countStatus(results, "timeout"),
    total_deterministic_findings: results.reduce((sum, result) => sum + result.findingCount, 0),
    total_files: totalFiles,
    total_loc: totalLoc,
    tool_results: results.map((result) => ({
      tool: result.tool,
      status: result.status,
      findings: result.findingCount,
      duration_ms: result.durationMs,
      ...(result.error === "" ? {} : { error: result.error }),
    })),
  };
  mkdirSync(join(auditDir, "data"), { recursive: true });
  writeFileSync(join(auditDir, "data", "pipeline-health.json"), dumpJson(report));
  return report;
}
