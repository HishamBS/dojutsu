// File-backed work-order helpers for session-resilient Dojutsu dispatches. A work order is a
// request file, a status file and, once its artifact exists, a digest of that artifact.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { isoFromEpochMs, nowIso, pyStr } from "@quality/py-format.ts";
import type { ScanPlan } from "@quality/types.ts";

type WorkOrderPayload = { artifact_path: string | null | undefined; state?: string } & Record<string, unknown>;
type ArtifactSummary = { artifact_path: string; sha256: string; size_bytes: number; line_count: number; updated_at: string };

const NEWLINE = 0x0a;
const FAILED_STATE = "failed";

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, dumpJson(payload) + "\n");
}

const workOrderRoot = (auditDir: string, stageName: string): string => join(auditDir, "data", "work-orders", stageName);

function artifactSummary(auditDir: string, artifactPath: string | null | undefined): ArtifactSummary | null {
  if (!artifactPath) return null;
  const absPath = isAbsolute(artifactPath) ? artifactPath : join(auditDir, artifactPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
  const bytes = readFileSync(absPath);
  const stat = statSync(absPath);
  return {
    artifact_path: artifactPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: stat.size,
    line_count: bytes.reduce((count, byte) => count + (byte === NEWLINE ? 1 : 0), 0),
    updated_at: isoFromEpochMs(stat.mtimeMs),
  };
}

function writeResponseFiles(workDir: string, summary: ArtifactSummary | null): void {
  const rawPath = join(workDir, "response.raw.txt");
  const normalizedPath = join(workDir, "response.normalized.json");
  if (summary === null) {
    rmSync(rawPath, { force: true });
    rmSync(normalizedPath, { force: true });
    return;
  }
  const rawLines = [
    `artifact_path: ${summary.artifact_path}`,
    `sha256: ${summary.sha256}`,
    `size_bytes: ${summary.size_bytes}`,
    `line_count: ${summary.line_count}`,
    `updated_at: ${summary.updated_at}`,
  ];
  writeFileSync(rawPath, rawLines.join("\n") + "\n");
  writeJson(normalizedPath, summary);
}

function existingCreatedAt(requestPath: string, fallback: string): string {
  if (!existsSync(requestPath) || !statSync(requestPath).isFile()) return fallback;
  let existing: unknown;
  try {
    existing = JSON.parse(readTextStrict(requestPath));
  } catch (error) {
    if (error instanceof SyntaxError) return nowIso();
    throw error;
  }
  if (!isRecord(existing)) throw new TypeError(`${requestPath}: expected an object`);
  const created = existing["created_at"];
  return created === undefined ? fallback : pyStr(created);
}

function upsertWorkOrder(auditDir: string, stageDir: string, unitId: string, payload: WorkOrderPayload): void {
  const workDir = join(stageDir, unitId);
  const summary = artifactSummary(auditDir, payload.artifact_path);
  const state = summary !== null && payload.state !== FAILED_STATE ? "complete" : (payload.state ?? "pending");
  const requestPath = join(workDir, "request.json");
  const createdAt = existingCreatedAt(requestPath, nowIso());
  const status = { updated_at: nowIso(), state, artifact_path: payload.artifact_path ?? null, artifact_present: summary !== null };
  writeJson(requestPath, { ...payload, created_at: createdAt, updated_at: nowIso() });
  writeJson(join(workDir, "status.json"), status);
  writeResponseFiles(workDir, summary);
}

export function writeScanWorkOrders(auditDir: string, scanPlan: ScanPlan): number {
  const stageDir = workOrderRoot(auditDir, "scanner");
  let count = 0;
  for (const batch of scanPlan.batches) {
    upsertWorkOrder(auditDir, stageDir, `batch-${batch.id}`, {
      kind: "scanner-batch",
      id: batch.id,
      layer: batch.layer,
      files: batch.files,
      artifact_path: batch.output_file,
      state: batch.status,
    });
    count += 1;
  }
  return count;
}

export function writeEnrichmentWorkOrders(auditDir: string, pendingLayers: Record<string, number>): number {
  const stageDir = workOrderRoot(auditDir, "enrichment");
  const layers = Object.entries(pendingLayers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [layerName, findingCount] of layers) {
    upsertWorkOrder(auditDir, stageDir, layerName, {
      kind: "layer-enrichment",
      layer: layerName,
      finding_count: findingCount,
      artifact_path: `data/enriched/${layerName}.jsonl`,
      state: "pending",
    });
  }
  return layers.length;
}

export function writeImpactWorkOrders(auditDir: string, clusters: Record<string, unknown>[], completedIds: ReadonlySet<string>): number {
  const stageDir = workOrderRoot(auditDir, "impact-analysis");
  let count = 0;
  for (const cluster of clusters) {
    const clusterId = pyStr(cluster["id"]);
    if (clusterId === "") continue;
    upsertWorkOrder(auditDir, stageDir, clusterId, {
      kind: "impact-analysis",
      cluster_id: clusterId,
      cluster_type: cluster["type"] ?? "",
      finding_count: cluster["finding_count"] ?? 0,
      finding_ids: cluster["finding_ids"] ?? [],
      files: cluster["files"] ?? [],
      artifact_path: `deep/impact-analysis-parts/${clusterId}.json`,
      state: completedIds.has(clusterId) ? "complete" : "pending",
    });
    count += 1;
  }
  return count;
}
