#!/usr/bin/env bun
// Usage: handle_partial_scan.ts <plan_path> <batch_id> <comma-separated-scanned-files>
// SCAN_PARTIAL recovery: records a partial scan in scan-plan.json and queues a follow-up batch
// for the files the scanner did not reach.
import { writeFileSync } from "node:fs";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { pyStr } from "@quality/py-format.ts";

export const UNSCANNED_FILES_KEY = "unscanned_files"; // the sentinel field scanner-prompt.md asks for

type PlanBatch = { id: number; layer: string; files: string[]; status: string; retries?: number; [extra: string]: unknown };
type ScanPlan = { total_batches?: number; batches: PlanBatch[]; [extra: string]: unknown };

function isBatch(value: unknown): value is PlanBatch {
  return (
    isRecord(value) &&
    typeof value["id"] === "number" &&
    typeof value["layer"] === "string" &&
    typeof value["status"] === "string" &&
    Array.isArray(value["files"]) &&
    value["files"].every((file) => typeof file === "string")
  );
}

function isScanPlan(value: unknown): value is ScanPlan {
  return isRecord(value) && Array.isArray(value["batches"]) && value["batches"].every(isBatch);
}

// The files a SCAN_PARTIAL scanner listed as not read, from its <output>.done sentinel.
export function unscannedFiles(outputPath: string): string[] {
  const sentinel: unknown = JSON.parse(readTextStrict(`${outputPath}.done`));
  if (!isRecord(sentinel)) throw new TypeError(`${outputPath}.done: expected a JSON object`);
  const listed = sentinel[UNSCANNED_FILES_KEY];
  return Array.isArray(listed) ? listed.map(pyStr) : [];
}

// Updates a loaded scan plan after a partial scan and returns the follow-up batch, if any.
// Some files scanned: the batch is marked partial and a new batch holds the rest. All files
// scanned: complete. None scanned: pending again, with its retry count raised for the
// circuit breaker.
export function applyPartialScan(plan: ScanPlan, batchId: number, scannedFiles: readonly string[]): PlanBatch | null {
  const target = plan.batches.find((batch) => batch.id === batchId);
  if (target === undefined) throw new Error(`Batch ${batchId} not found in the scan plan`);

  const scanned = new Set(scannedFiles);
  const remaining = target.files.filter((file) => !scanned.has(file));
  if (scannedFiles.length === 0) {
    target.status = "pending";
    target.retries = (target.retries ?? 0) + 1;
    return null;
  }
  if (remaining.length === 0) {
    target.status = "complete";
    return null;
  }

  target.status = "partial";
  const nextId = Math.max(...plan.batches.map((batch) => batch.id)) + 1;
  const followUp: PlanBatch = {
    id: nextId,
    layer: target.layer,
    files: remaining,
    status: "pending",
    output_file: `data/scanner-output/scanner-${nextId}-${target.layer}.jsonl`,
    finding_count: 0,
    parent_batch: batchId,
  };
  plan.batches.push(followUp);
  plan.total_batches = plan.batches.length;
  return followUp;
}

export function recoverPartialBatch(planPath: string, batchId: number, scannedFiles: readonly string[]): void {
  const plan: unknown = JSON.parse(readTextStrict(planPath));
  if (!isScanPlan(plan)) throw new TypeError(`${planPath}: expected a scan plan with a batches list`);
  applyPartialScan(plan, batchId, scannedFiles);
  writeFileSync(planPath, dumpJson(plan));
}

if (import.meta.main) {
  const [planPath, batchId, scanned] = process.argv.slice(2);
  if (planPath === undefined || batchId === undefined || scanned === undefined) {
    console.log("Usage: handle_partial_scan.ts <plan_path> <batch_id> <comma-separated-scanned-files>");
    process.exit(1);
  }
  recoverPartialBatch(planPath, Number.parseInt(batchId, 10), scanned === "" ? [] : scanned.split(","));
}
