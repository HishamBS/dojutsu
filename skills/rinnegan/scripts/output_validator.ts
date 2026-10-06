// Three-tier completeness check for session-resilient output validation. It detects a
// complete output on disk even without an explicit status update, so a session cut short by
// a rate limit or context exhaustion can be recovered rather than rerun.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps } from "@quality/py-format.ts";
import { pyStrip, universalLines } from "@quality/py-text.ts";

export type JsonlIntegrity = { valid: number; total: number; error: string | null };
export type Completeness = { complete: string[]; incomplete: string[] };

// A layer counts as enriched once at least this share of its findings came back.
const ENRICHMENT_THRESHOLD = 0.8;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function countNonBlankLines(path: string): number {
  return universalLines(readTextStrict(path)).filter((line) => pyStrip(line) !== "").length;
}

// A sentinel for an output that was complete on disk without one.
function writeSentinel(sentinelPath: string, lineCount: number): void {
  writeFileSync(sentinelPath, pyJsonDumps({ lines: lineCount, auto_recovered: true, timestamp: nowIso() }));
}

// Checks every non-blank line is valid JSON, stopping at the first that is not.
export function validateJsonlIntegrity(path: string): JsonlIntegrity {
  let valid = 0;
  let total = 0;
  const lines = universalLines(readTextStrict(path));
  for (const [index, raw] of lines.entries()) {
    const stripped = pyStrip(raw);
    if (stripped === "") continue;
    total += 1;
    try {
      JSON.parse(stripped);
    } catch (error) {
      return { valid, total, error: `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}` };
    }
    valid += 1;
  }
  return { valid, total, error: null };
}

// Tier 1: a sentinel exists and its line count matches the file. Tier 2: no sentinel, but the
// file is non-empty valid JSONL, which gets a sentinel. Tier 3: no file, or an empty one.
export function isOutputComplete(outputPath: string): boolean {
  const sentinelPath = `${outputPath}.done`;

  if (isFile(sentinelPath)) {
    let sentinel: unknown;
    try {
      sentinel = JSON.parse(readTextStrict(sentinelPath));
    } catch {
      return false;
    }
    if (!isRecord(sentinel) || !isFile(outputPath)) return false;
    return countNonBlankLines(outputPath) === (sentinel["lines"] ?? -1);
  }

  if (isFile(outputPath)) {
    const actualLines = countNonBlankLines(outputPath);
    if (actualLines === 0) return false;
    const { valid, total, error } = validateJsonlIntegrity(outputPath);
    if (error === null && valid === total) {
      writeSentinel(sentinelPath, actualLines);
      return true;
    }
  }
  return false;
}

// Per layer of findingsPath, whether its enriched output is complete and holds at least 80
// percent of the layer's findings. Unreadable findings and rows without a layer are skipped.
export function validateEnrichmentCompleteness(findingsPath: string, enrichedDir: string): Completeness {
  const layerCounts = new Map<string, number>();
  if (isFile(findingsPath)) {
    for (const raw of universalLines(readTextStrict(findingsPath))) {
      const stripped = pyStrip(raw);
      if (stripped === "") continue;
      let finding: unknown;
      try {
        finding = JSON.parse(stripped);
      } catch {
        continue;
      }
      const layer = isRecord(finding) ? finding["layer"] : undefined;
      if (typeof layer === "string" && layer !== "") layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }
  }

  const result: Completeness = { complete: [], incomplete: [] };
  for (const [layer, expectedCount] of layerCounts) {
    const enrichedPath = join(enrichedDir, `${layer}.jsonl`);
    const enriched = isOutputComplete(enrichedPath) && countNonBlankLines(enrichedPath) >= expectedCount * ENRICHMENT_THRESHOLD;
    (enriched ? result.complete : result.incomplete).push(layer);
  }
  return result;
}
