#!/usr/bin/env bun
// Usage: check-scan-progress.ts <audit_dir>
// Reads data/scan-plan.json and reports scan progress, listing the next batches to dispatch.
import { join } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";

const NEXT_BATCH_LIMIT = 5;

type Batch = { id: number; layer: string; files: string[]; status: string; output_file: string };

function isBatch(value: unknown): value is Batch {
  return (
    isRecord(value) &&
    typeof value["id"] === "number" &&
    typeof value["layer"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["output_file"] === "string" &&
    Array.isArray(value["files"]) &&
    value["files"].every((file) => typeof file === "string")
  );
}

if (import.meta.main) {
  const auditDir = process.argv[2];
  if (auditDir === undefined) {
    console.error("Usage: check-scan-progress.ts <audit_dir>");
    process.exit(1);
  }
  const plan: unknown = JSON.parse(readTextStrict(join(auditDir, "data", "scan-plan.json")));
  if (!isRecord(plan) || typeof plan["total_batches"] !== "number" || !Array.isArray(plan["batches"]) || !plan["batches"].every(isBatch)) {
    throw new TypeError("scan-plan.json: expected total_batches and a batches list");
  }
  const pending = plan["batches"].filter((batch) => batch.status === "pending");
  const complete = plan["batches"].filter((batch) => batch.status === "complete");
  console.log(`SCAN_PROGRESS: ${complete.length}/${plan["total_batches"]} complete, ${pending.length} pending`);
  if (pending.length === 0) {
    console.log("ALL_BATCHES_COMPLETE");
  } else {
    for (const batch of pending.slice(0, NEXT_BATCH_LIMIT)) {
      console.log(`  PENDING: batch ${batch.id} layer=${batch.layer} output=${batch.output_file} file_count=${batch.files.length}`);
      console.log(`  FILES: ${batch.files.join(" ")}`);
    }
  }
}
