#!/usr/bin/env bun
// Usage: create-scan-plan.ts <audit_dir>
// Creates scan-plan.json with one batch per max_batch_for("scanner") source files.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import type { ScanBatch, ScanPlan } from "@quality/types.ts";
import { DojutsuConfig } from "@rinnegan/dojutsu_config.ts";

const SKIP_TAGS: readonly string[] = ["OVERSIZED", "GENERATED"];
const DEFAULT_TAG = "SOURCE";
const DEFAULT_LAYER = "mixed";
const SCANNER_ROLE = "scanner";

type PlanEntry = { path: string; layer: string; tag: string; nominal: boolean; isMeta: boolean };
type PlanInventory = { entries: PlanEntry[]; totalLoc: unknown };

function stringField(file: Record<string, unknown>, key: string, fallback: string): string {
  const value = file[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new TypeError(`inventory file ${key}: expected a string`);
  return value;
}

function readPlanInventory(auditDir: string): PlanInventory {
  const inventory: unknown = JSON.parse(readTextStrict(join(auditDir, "data", "inventory.json")));
  if (!isRecord(inventory) || !Array.isArray(inventory["files"])) throw new TypeError("inventory.json: missing files list");
  const entries = (inventory["files"] as unknown[]).map((file): PlanEntry => {
    if (!isRecord(file)) throw new TypeError("inventory.json: a file entry is not an object");
    const path = file["path"];
    if (typeof path !== "string") throw new TypeError("inventory file path: expected a string");
    return {
      path,
      layer: stringField(file, "layer", DEFAULT_LAYER),
      tag: stringField(file, "tag", DEFAULT_TAG),
      nominal: Boolean(file["nominal"]),
      isMeta: Boolean(file["is_meta_file"]),
    };
  });
  return { entries, totalLoc: inventory["total_loc"] };
}

// Batch the scannable files: not oversized, generated, nominal or meta.
export function buildPlan(auditDir: string): ScanPlan {
  const config = new DojutsuConfig();
  const { entries, totalLoc } = readPlanInventory(auditDir);
  const files = entries.filter((e) => !SKIP_TAGS.includes(e.tag) && !e.nominal && !e.isMeta).map((e) => e.path);
  const pathToLayer = new Map(entries.map((e) => [e.path, e.layer]));

  let avgLoc = 0;
  if (files.length > 0) {
    if (typeof totalLoc !== "number") throw new TypeError("inventory.json: total_loc is required and must be a number");
    avgLoc = Math.floor(totalLoc / Math.max(files.length, 1));
  }
  const batchSize = config.maxBatchFor(SCANNER_ROLE, avgLoc);
  const batches: ScanBatch[] = [];
  for (let i = 0; i * batchSize < files.length; i += 1) {
    const batchFiles = files.slice(i * batchSize, (i + 1) * batchSize);
    const layer = pathToLayer.get(batchFiles[0] ?? "") ?? DEFAULT_LAYER;
    batches.push({
      id: i + 1,
      layer,
      files: batchFiles,
      status: "pending",
      output_file: `data/scanner-output/scanner-${i + 1}-${layer}.jsonl`,
      finding_count: 0,
    });
  }
  const plan: ScanPlan = { total_batches: batches.length, completed: 0, batches };
  writeFileSync(join(auditDir, "data", "scan-plan.json"), dumpJson(plan));
  return plan;
}

if (import.meta.main) {
  const [auditDir] = process.argv.slice(2);
  if (auditDir === undefined) {
    console.error("Usage: create-scan-plan.ts <audit_dir>");
    process.exit(1);
  }
  const plan = buildPlan(auditDir);
  const skipped = readPlanInventory(auditDir).entries.filter((e) => SKIP_TAGS.includes(e.tag)).length;
  const batched = plan.batches.reduce((sum, batch) => sum + batch.files.length, 0);
  console.log(`Created scan plan: ${plan.total_batches} batches for ${batched} files (skipped ${skipped} ${SKIP_TAGS.join("/")})`);
}
