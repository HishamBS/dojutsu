#!/usr/bin/env bun
// Merge per-cluster impact analysis artifacts into the published JSONL.
// Usage: merge_impact_analysis.ts <project_dir>
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps, pyStr } from "@quality/py-format.ts";

const PARTS_DIRNAME = "impact-analysis-parts";
const FINAL_FILENAME = "impact-analysis.jsonl";
const MANIFEST_FILENAME = "impact-analysis-manifest.json";
const REQUIRED_NARRATIVE_FIELDS: readonly string[] = ["root_cause", "systemic_pattern", "business_impact", "why_it_exists"];
const REQUIRED_APPROACH_FIELDS: readonly string[] = ["strategy", "description", "fix_order", "fix_blast_radius_files", "risk_assessment", "validation_steps"];
const VALID_STRATEGIES: ReadonlySet<string> = new Set(["extract_and_replace", "inline_fix", "refactor_pattern", "config_centralize", "wrap_and_deprecate"]);

type Json = Record<string, unknown>;

export type ImpactStatus = {
  parts_dir: string;
  expected_clusters: string[];
  completed_clusters: string[];
  missing_clusters: string[];
  invalid_parts: string[];
  complete: boolean;
  merge_needed: boolean;
};
export type ImpactManifest = {
  generated_at: string;
  expected_clusters: string[];
  completed_clusters: string[];
  source_files: string[];
  merged_findings: number;
  final_output: string;
};

// A part that cannot be published; the message names the part.
export class ImpactPartError extends Error {}

function loadJson(path: string): Json {
  const value: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(value)) throw new ImpactPartError(`${path}: expected an object`);
  return value;
}

function loadClusterPayload(path: string): Json {
  const raw = readTextStrict(path).trim();
  if (raw === "") throw new ImpactPartError(`empty impact part: ${path}`);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    const rows = raw.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "").map((line): unknown => JSON.parse(line));
    const [only] = rows;
    if (rows.length === 1 && isRecord(only)) payload = only;
    else throw new ImpactPartError(`unsupported impact format in ${path}`);
  }
  if (!isRecord(payload)) throw new ImpactPartError(`impact payload must be a JSON object: ${path}`);
  return payload;
}

function requireNonEmptyString(payload: Json, key: string, path: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") throw new ImpactPartError(`impact payload missing non-empty string '${key}': ${path}`);
  return value;
}

function requireStringList(payload: Json, key: string, path: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new ImpactPartError(`impact payload missing non-empty list '${key}': ${path}`);
  return (value as unknown[]).map((item) => {
    if (typeof item !== "string" || item.trim() === "") throw new ImpactPartError(`impact payload has invalid string list '${key}': ${path}`);
    return item;
  });
}

const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function validateClusterPayload(payload: Json, clusterId: string, path: string): Json & { findings: Json[] } {
  if (pyStr(payload["cluster_id"] ?? "").trim() !== clusterId) throw new ImpactPartError(`impact payload cluster_id mismatch: ${path}`);
  requireNonEmptyString(payload, "cluster_label", path);
  requireNonEmptyString(payload, "analyzed_at", path);
  const sourceFiles = requireStringList(payload, "source_files_read", path);

  const readCount = payload["read_count"];
  if (typeof readCount !== "number" || !Number.isInteger(readCount) || readCount < sourceFiles.length) throw new ImpactPartError(`impact payload has invalid read_count: ${path}`);

  const findings = payload["findings"];
  if (!Array.isArray(findings) || findings.length === 0) throw new ImpactPartError(`impact payload missing non-empty findings list: ${path}`);
  for (const finding of findings as unknown[]) {
    if (!isRecord(finding)) throw new ImpactPartError(`impact payload findings must contain objects: ${path}`);
    requireNonEmptyString(finding, "finding_id", path);
    requireNonEmptyString(finding, "file", path);
    const line = finding["line"];
    if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) throw new ImpactPartError(`impact finding has invalid line: ${path}`);
  }

  const narrative = payload["cluster_narrative"];
  if (!isRecord(narrative)) throw new ImpactPartError(`impact payload missing cluster_narrative object: ${path}`);
  for (const field of REQUIRED_NARRATIVE_FIELDS) requireNonEmptyString(narrative, field, path);

  const approach = payload["recommended_approach"];
  if (!isRecord(approach)) throw new ImpactPartError(`impact payload missing recommended_approach object: ${path}`);
  for (const field of REQUIRED_APPROACH_FIELDS) {
    if (!(field in approach)) throw new ImpactPartError(`impact payload missing recommended_approach.${field}: ${path}`);
  }
  if (!VALID_STRATEGIES.has(requireNonEmptyString(approach, "strategy", path))) throw new ImpactPartError(`impact payload has invalid strategy: ${path}`);
  requireNonEmptyString(approach, "description", path);
  const fixOrder = requireStringList(approach, "fix_order", path);
  requireStringList(approach, "validation_steps", path);
  if (!isNonNegativeInteger(approach["fix_blast_radius_files"])) throw new ImpactPartError(`impact payload has invalid fix_blast_radius_files: ${path}`);
  requireNonEmptyString(approach, "risk_assessment", path);

  const findingIds = new Set((findings as Json[]).map((finding) => pyStr(finding["finding_id"] ?? "").trim()));
  if (fixOrder.some((id) => !findingIds.has(id))) throw new ImpactPartError(`impact payload fix_order references unknown finding ids: ${path}`);
  return { ...payload, findings: findings as Json[] };
}

function writeSentinel(path: string, lines: number): void {
  writeFileSync(`${path}.done`, dumpJson({ lines, auto_recovered: false, timestamp: nowIso() }) + "\n");
}

const partPath = (partsDir: string, clusterId: string): string => join(partsDir, `${clusterId}.json`);

function loadValidPart(partsDir: string, clusterId: string): Json & { findings: Json[] } {
  const path = partPath(partsDir, clusterId);
  return validateClusterPayload(loadClusterPayload(path), clusterId, path);
}

const sameList = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && b.every((item, index) => a[index] === item);

// Whether the merged output no longer reflects the parts it was built from.
function mergeIsStale(auditDir: string, deepDir: string, partsDir: string, expected: string[], completed: string[]): boolean {
  const finalPath = join(deepDir, FINAL_FILENAME);
  const manifestPath = join(deepDir, MANIFEST_FILENAME);
  if (!existsSync(finalPath) || !statSync(finalPath).isFile() || !existsSync(manifestPath) || !statSync(manifestPath).isFile()) return true;
  let manifest: Json;
  try {
    manifest = loadJson(manifestPath);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ImpactPartError) return true;
    throw error;
  }
  const sourceFiles = completed.map((id) => relative(auditDir, partPath(partsDir, id)));
  const expectedFindings = completed.reduce((sum, id) => sum + loadValidPart(partsDir, id).findings.length, 0);
  if (!sameList(manifest["expected_clusters"], expected)) return true;
  if (!sameList(manifest["completed_clusters"], completed)) return true;
  if (!sameList(manifest["source_files"], sourceFiles)) return true;
  if (manifest["merged_findings"] !== expectedFindings) return true;
  if (manifest["final_output"] !== relative(auditDir, finalPath)) return true;

  const finalMtime = statSync(finalPath).mtimeMs;
  if (statSync(manifestPath).mtimeMs < finalMtime) return true;
  return completed.some((id) => statSync(partPath(partsDir, id)).mtimeMs > finalMtime);
}

// Which clusters' impact parts exist, are valid, are missing or invalid, and whether the merged
// output is up to date. A project whose clusters.json lists no cluster has nothing left to analyze.
export function impactOutputStatus(projectDir: string): ImpactStatus {
  const auditDir = join(projectDir, "docs", "audit");
  const deepDir = join(auditDir, "deep");
  const clustersPath = join(deepDir, "clusters.json");
  const hasClusters = existsSync(clustersPath) && statSync(clustersPath).isFile();
  let expected: string[] = [];
  if (hasClusters) {
    const clusters = loadJson(clustersPath)["clusters"] ?? [];
    if (!Array.isArray(clusters)) throw new TypeError("clusters.json: clusters must be a list");
    expected = (clusters as unknown[]).map((cluster) => {
      if (!isRecord(cluster)) throw new TypeError("clusters.json: a cluster is not an object");
      return pyStr(cluster["id"] ?? "");
    }).filter((id) => id.trim() !== "");
  }

  const partsDir = join(deepDir, PARTS_DIRNAME);
  const completed: string[] = [];
  const invalid: string[] = [];
  if (existsSync(partsDir) && statSync(partsDir).isDirectory()) {
    for (const id of expected) {
      const path = partPath(partsDir, id);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      try {
        loadValidPart(partsDir, id);
        completed.push(id);
      } catch (error) {
        if (!(error instanceof ImpactPartError) && !(error instanceof SyntaxError)) throw error;
        invalid.push(id);
      }
    }
  }
  const missing = expected.filter((id) => !completed.includes(id) && !invalid.includes(id));
  const complete = hasClusters && missing.length === 0 && invalid.length === 0;
  return {
    parts_dir: partsDir,
    expected_clusters: expected,
    completed_clusters: completed,
    missing_clusters: missing,
    invalid_parts: invalid,
    complete,
    merge_needed: complete && mergeIsStale(auditDir, deepDir, partsDir, expected, completed),
  };
}

export function mergeImpactAnalysisOutputs(projectDir: string): ImpactManifest {
  const status = impactOutputStatus(projectDir);
  if (!status.complete) throw new ImpactPartError("impact analysis parts are incomplete");

  const auditDir = join(projectDir, "docs", "audit");
  const deepDir = join(auditDir, "deep");
  const rows: Json[] = [];
  const sourceFiles: string[] = [];
  for (const clusterId of status.completed_clusters) {
    const payload = loadValidPart(status.parts_dir, clusterId);
    sourceFiles.push(relative(auditDir, partPath(status.parts_dir, clusterId)));
    for (const finding of payload.findings) {
      rows.push({
        ...finding,
        cluster_id: pyStr(payload["cluster_id"] ?? clusterId),
        cluster_label: pyStr(payload["cluster_label"] ?? ""),
        analyzed_at: payload["analyzed_at"],
        cluster_narrative: payload["cluster_narrative"],
        recommended_approach: payload["recommended_approach"],
      });
    }
  }

  mkdirSync(deepDir, { recursive: true });
  const finalPath = join(deepDir, FINAL_FILENAME);
  writeFileSync(finalPath, rows.map((row) => pyJsonDumps(row) + "\n").join(""));
  writeSentinel(finalPath, rows.length);

  const manifest: ImpactManifest = {
    generated_at: nowIso(),
    expected_clusters: status.expected_clusters,
    completed_clusters: status.completed_clusters,
    source_files: sourceFiles,
    merged_findings: rows.length,
    final_output: relative(auditDir, finalPath),
  };
  writeFileSync(join(deepDir, MANIFEST_FILENAME), dumpJson(manifest) + "\n");
  return manifest;
}

if (import.meta.main) {
  const [projectArg] = process.argv.slice(2);
  if (projectArg === undefined) {
    console.log("Usage: merge_impact_analysis.ts <project_dir>");
    process.exit(1);
  }
  const projectDir = resolve(projectArg);
  const status = impactOutputStatus(projectDir);
  if (!status.complete) {
    console.log("IMPACT_PARTS_INCOMPLETE");
    console.log(`completed=${status.completed_clusters.length} missing=${status.missing_clusters.length} invalid=${status.invalid_parts.length}`);
    process.exit(1);
  }
  const manifest = mergeImpactAnalysisOutputs(projectDir);
  console.log(`IMPACT_MERGED: ${manifest.merged_findings} findings from ${manifest.completed_clusters.length} clusters`);
}
