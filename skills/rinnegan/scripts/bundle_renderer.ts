#!/usr/bin/env bun
// Usage: bundle_renderer.ts <render|check> <audit_dir> [rinnegan|byakugan]
// Compile the deterministic audit bundle documents from the SSOT data files. `render` writes
// them; `check` reports any document that is missing or has drifted from its rendering, and
// repairs nothing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso } from "@quality/py-format.ts";
import { pyRound } from "@quality/py-round.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";
import { PHASE_FILE_SLUGS, SPEC_PHASE_NODES } from "@rinnegan/phase-contract.ts";
import { renderDeploymentPlan, renderExecutiveBrief, renderNarrative, renderScorecard } from "@rinnegan/report-renderers/deep.ts";
import { renderAgentInstructions, renderCrossCutting, renderLayerDoc, renderMasterAudit, renderProgress } from "@rinnegan/report-renderers/audit.ts";
import type { BundleModel, ClusterSummary, CrossCuttingGroup, Json, LayerDoc, PhaseDoc } from "@rinnegan/report-renderers/model.ts";
import { compareSeverityKeys, DEFAULT_PHASE, field, pyInt, pyStr, severityRank } from "@rinnegan/report-renderers/model.ts";

export type Stage = "rinnegan" | "byakugan";
export type RenderResult = { written: string[]; mismatches: string[]; count: number };

const SEVERITY_WEIGHTS: Readonly<Record<string, number>> = { CRITICAL: 10.0, HIGH: 3.0, MEDIUM: 1.0, LOW: 0.2, REVIEW: 0.0 };
const LOC_PER_KLOC = 1000;
const MIN_KLOC = 1.0;
const FULL_SCORE = 100.0;
const SCORE_DIGITS = 2;
const USAGE_EXIT_CODE = 1;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function loadJson(path: string): Json {
  if (!isFile(path)) return {};
  const parsed: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(parsed)) throw new TypeError(`${path}: expected a JSON object`);
  return parsed;
}

function loadJsonl(path: string): Json[] {
  if (!isFile(path)) return [];
  const rows: Json[] = [];
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const row: unknown = JSON.parse(stripped);
    if (!isRecord(row)) throw new TypeError(`${path}: a row is not a JSON object`);
    rows.push(row);
  }
  return rows;
}

const lookup = (row: Json, key: string, fallback: unknown): unknown => (Object.hasOwn(row, key) ? row[key] : fallback);
const objectOrEmpty = (value: unknown): Json => (isRecord(value) ? value : {});
const listOrEmpty = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The generation stamp of the model already on disk, so a rerender never changes it.
function existingGeneratedAt(auditDir: string): string | null {
  const generatedAt = loadJson(join(auditDir, "data", "bundle-model.json"))["generated_at"];
  return typeof generatedAt === "string" && pyStrip(generatedAt) !== "" ? generatedAt : null;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string | number): Map<string | number, T[]> {
  const groups = new Map<string | number, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

function phaseOf(finding: Json): number {
  return pyInt(lookup(finding, "phase", DEFAULT_PHASE)) ?? DEFAULT_PHASE;
}

const mustFixIds = (findings: readonly Json[]): string[] =>
  [...findings]
    .sort(compareSeverityKeys)
    .filter((finding) => ["CRITICAL", "HIGH"].includes(field(finding, "severity", "")) || finding["is_root_cause"] === true)
    .map((finding) => field(finding, "id"));

function buildPhaseDocs(dataDir: string, findingsByPhase: ReadonlyMap<number, Json[]>): PhaseDoc[] {
  return SPEC_PHASE_NODES.map((node) => {
    const payload = loadJson(join(dataDir, "tasks", `phase-${node.id}-tasks.json`));
    const taskList = listOrEmpty(payload["tasks"]);
    return {
      phase: node.id,
      name: node.name,
      path: `phases/phase-${node.id}-${PHASE_FILE_SLUGS[node.id]}.md`,
      tasks: pyInt(lookup(payload, "total_tasks", taskList.length)) ?? 0,
      status: lookup(payload, "status", findingsByPhase.has(node.id) ? "not_started" : "clear"),
    };
  });
}

function buildClusterSummaries(clusterEntries: readonly Json[], impactRows: readonly Json[], byId: Readonly<Record<string, Json>>): ClusterSummary[] {
  const impactByCluster = groupBy(impactRows, (row) => field(row, "cluster_id", ""));
  return clusterEntries.map((cluster) => {
    const clusterId = field(cluster, "id", "");
    const rows = [...(impactByCluster.get(clusterId) ?? [])].sort((a, b) => {
      const rank = (row: Json): number => severityRank(field(objectOrEmpty(byId[field(row, "finding_id", "")]), "severity", "MEDIUM"));
      return rank(a) - rank(b) || compareText(field(a, "finding_id", ""), field(b, "finding_id", ""));
    });
    const first = rows[0];
    return {
      id: clusterId,
      name: field(cluster, "name", ""),
      type: field(cluster, "type", ""),
      rules: listOrEmpty(cluster["rules"]),
      finding_count: pyInt(lookup(cluster, "finding_count", listOrEmpty(cluster["finding_ids"]).length)) ?? 0,
      max_severity: field(cluster, "max_severity", "LOW"),
      root_pattern: field(cluster, "root_pattern", ""),
      files: listOrEmpty(cluster["files"]),
      finding_ids: listOrEmpty(cluster["finding_ids"]),
      impact_rows: rows,
      cluster_narrative: first === undefined ? {} : lookup(first, "cluster_narrative", {}),
      recommended_approach: first === undefined ? {} : lookup(first, "recommended_approach", {}),
    };
  });
}

function buildCrossCuttingGroups(findings: readonly Json[]): CrossCuttingGroup[] {
  const groups = groupBy(
    findings.filter((finding) => isPyTruthy(finding["cross_cutting"]) && isPyTruthy(finding["cross_cutting_group"])),
    (finding) => pyStr(finding["cross_cutting_group"]),
  );
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || compareText(String(a[0]), String(b[0])))
    .map(([name, members]) => ({
      name: String(name),
      instances: members,
      count: members.length,
      layers: [...new Set(members.map((member) => field(member, "layer", "")))].sort(compareText),
      highest_severity: members.map((member) => field(member, "severity", "LOW")).reduce((best, next) => (severityRank(next) < severityRank(best) ? next : best)),
      rule: field(members[0] ?? {}, "rule", ""),
    }));
}

// Everything the audit documents are rendered from, read once from the SSOT data files.
export function buildBundleModel(auditDir: string): BundleModel {
  const dataDir = join(auditDir, "data");
  const deepDir = join(auditDir, "deep");
  const findings = loadJsonl(join(dataDir, "findings.jsonl"));
  const inventory = loadJson(join(dataDir, "inventory.json"));
  const stats = loadJson(join(dataDir, "audit-stats.json"));
  const qualityGate = loadJson(join(dataDir, "quality-gate.json"));
  const families = loadJson(join(dataDir, "finding-families.json"));
  const clusters = loadJson(join(deepDir, "clusters.json"));
  const impactRows = loadJsonl(join(deepDir, "impact-analysis.jsonl"));
  const reportManifest = loadJson(join(dataDir, "report-manifest.json"));

  const findingsSorted = [...findings].sort(compareSeverityKeys);
  const byId: Record<string, Json> = {};
  for (const finding of findingsSorted) byId[field(finding, "id")] = finding;
  const findingsByLayer = groupBy(findingsSorted, (finding) => field(finding, "layer", "misc"));
  const findingsByPhase = new Map<number, Json[]>();
  for (const finding of findingsSorted) {
    const phase = phaseOf(finding);
    findingsByPhase.set(phase, [...(findingsByPhase.get(phase) ?? []), finding]);
  }

  const affectedFiles = [...new Set(findingsSorted.map((finding) => field(finding, "file")).filter((file) => file !== ""))].sort(compareText);
  const totalLoc = pyInt(lookup(stats, "total_loc", isPyTruthy(inventory["total_loc"]) ? inventory["total_loc"] : 0)) ?? 0;
  const weighted = findingsSorted.reduce((sum, finding) => sum + (Object.hasOwn(SEVERITY_WEIGHTS, field(finding, "severity", "LOW")) ? (SEVERITY_WEIGHTS[field(finding, "severity", "LOW")] ?? 0) : 0), 0);
  const kloc = Math.max(totalLoc / LOC_PER_KLOC, MIN_KLOC);
  const readiness = pyRound(Math.max(0, Math.min(FULL_SCORE, FULL_SCORE - weighted / kloc)), SCORE_DIGITS);

  const clusterEntries = listOrEmpty(clusters["clusters"]).map(objectOrEmpty);
  const clusterIndex: Record<string, Json> = {};
  for (const cluster of clusterEntries) if (field(cluster, "id", "") !== "") clusterIndex[field(cluster, "id", "")] = cluster;

  const blockerIds: Record<string, string[]> = {};
  for (const [tier, payload] of Object.entries(objectOrEmpty(qualityGate["tiers"]))) {
    if (isRecord(payload)) blockerIds[tier] = listOrEmpty(payload["blocker_finding_ids"]).map(pyStr);
  }

  const layerInventory = objectOrEmpty(inventory["layers"]);
  const layerDocs: LayerDoc[] = [...findingsByLayer.entries()]
    .sort((a, b) => b[1].length - a[1].length || compareText(String(a[0]), String(b[0])))
    .map(([name, members]) => {
      const layer = objectOrEmpty(layerInventory[String(name)]);
      return { name: String(name), files: listOrEmpty(layer["files"]), loc: pyInt(lookup(layer, "loc", 0)) ?? 0, findings: members, path: `layers/${String(name)}.md` };
    });

  return {
    generated_at: existingGeneratedAt(auditDir) ?? nowIso(),
    project_name: pyStr(lookup(stats, "project_name", lookup(inventory, "root", "unknown"))),
    stack: pyStr(lookup(stats, "stack", lookup(inventory, "stack", "unknown"))),
    framework: pyStr(lookup(stats, "framework", lookup(inventory, "framework", "unknown"))),
    total_files_scanned: pyInt(lookup(stats, "total_files", isPyTruthy(inventory["total_files"]) ? inventory["total_files"] : 0)) ?? 0,
    total_loc: totalLoc,
    total_findings: findingsSorted.length,
    affected_files: affectedFiles,
    affected_file_count: affectedFiles.length,
    severity: objectOrEmpty(lookup(stats, "severity", {})),
    categories: listOrEmpty(lookup(stats, "categories", [])),
    layers: layerDocs,
    phases: buildPhaseDocs(dataDir, findingsByPhase),
    cross_cutting_groups: buildCrossCuttingGroups(findingsSorted),
    critical_findings: findingsSorted.filter((finding) => field(finding, "severity", "") === "CRITICAL"),
    must_fix_ids: mustFixIds(findingsSorted),
    quality_gate: qualityGate,
    blocker_finding_ids: blockerIds,
    families: listOrEmpty(families["families"]),
    clusters: buildClusterSummaries(clusterEntries, impactRows, byId),
    report_manifest: reportManifest,
    readiness_score: readiness,
    finding_index: byId,
    cluster_index: clusterIndex,
    impact_rows: impactRows,
  };
}

// Every document of the bundle for a stage, keyed by its audit-relative path.
function renderBundleOutputs(auditDir: string, stage: Stage): Map<string, string> {
  const model = buildBundleModel(auditDir);
  const outputs = new Map<string, string>([
    ["data/bundle-model.json", dumpJson(model) + "\n"],
    ["master-audit.md", renderMasterAudit(model)],
    ["cross-cutting.md", renderCrossCutting(model)],
    ["progress.md", renderProgress(model)],
    ["agent-instructions.md", renderAgentInstructions(model)],
  ]);
  for (const layer of model.layers) outputs.set(layer.path, renderLayerDoc(model, layer));
  if (stage === "byakugan") {
    outputs.set("deep/executive-brief.md", renderExecutiveBrief(model));
    outputs.set("deep/scorecard.md", renderScorecard(model));
    outputs.set("deep/deployment-plan.md", renderDeploymentPlan(model));
    outputs.set("deep/narrative.md", renderNarrative(model));
  }
  return outputs;
}

const normalizeContent = (content: string): string => content.trimEnd() + "\n";

// Write the bundle (or, with `check`, only report the documents that are missing or differ).
export function renderBundle(auditDir: string, stage: Stage, check = false): RenderResult {
  const outputs = renderBundleOutputs(auditDir, stage);
  const mismatches: string[] = [];
  const written: string[] = [];
  for (const [relPath, content] of outputs) {
    const absPath = join(auditDir, relPath);
    const normalized = normalizeContent(content);
    if (check) {
      if (!isFile(absPath) || readTextStrict(absPath).replace(/\r\n?/g, "\n") !== normalized) mismatches.push(relPath);
      continue;
    }
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, normalized);
    written.push(relPath);
  }
  return { written, mismatches, count: outputs.size };
}

export type BundleVerdict = { generated_at: string; stage: Stage; ok: boolean; errors: string[]; source_hashes: Record<string, string> };

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// Record the verdict of a validation run, with the hash of every source it judged.
export function writeBundleVerdict(auditDir: string, stage: Stage, validationErrors: readonly string[]): BundleVerdict {
  const dataDir = join(auditDir, "data");
  const sources = [
    join(dataDir, "findings.jsonl"),
    join(dataDir, "audit-stats.json"),
    join(dataDir, "quality-gate.json"),
    join(dataDir, "report-manifest.json"),
    join(dataDir, "bundle-model.json"),
    ...(stage === "byakugan" ? [join(auditDir, "deep", "clusters.json"), join(auditDir, "deep", "impact-analysis.jsonl")] : []),
  ];
  const hashes: Record<string, string> = {};
  for (const path of sources) if (isFile(path)) hashes[relative(auditDir, path)] = sha256(path);
  const verdict: BundleVerdict = { generated_at: nowIso(), stage, ok: validationErrors.length === 0, errors: [...validationErrors], source_hashes: hashes };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "bundle-verdict.json"), dumpJson(verdict) + "\n");
  return verdict;
}

function main(argv: readonly string[]): number {
  const [command, auditArg, stageArg] = argv;
  if (command === undefined || auditArg === undefined) {
    console.log("Usage: bundle_renderer.ts <render|check> <audit_dir> <rinnegan|byakugan>");
    return USAGE_EXIT_CODE;
  }
  const auditDir = resolve(auditArg);
  const stage: Stage = stageArg === "byakugan" ? "byakugan" : "rinnegan";
  const label = stageArg ?? "rinnegan";
  if (command === "render") {
    console.log(`BUNDLE_RENDER_COMPLETE stage=${label} files=${renderBundle(auditDir, stage, false).count}`);
    return 0;
  }
  if (command === "check") {
    const result = renderBundle(auditDir, stage, true);
    if (result.mismatches.length > 0) {
      console.log(`BUNDLE_RENDER_MISMATCH stage=${label}`);
      for (const relPath of result.mismatches) console.log(`- ${relPath}`);
      return USAGE_EXIT_CODE;
    }
    console.log(`BUNDLE_RENDER_VALID stage=${label}`);
    return 0;
  }
  console.log(`Unknown command: ${command}`);
  return USAGE_EXIT_CODE;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
