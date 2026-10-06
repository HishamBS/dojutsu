#!/usr/bin/env bun
// The deterministic audit publication contract: the canonical output paths, the phase
// markdown documents generated from the task JSON, the report manifest, and the validation of
// a published audit bundle.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";
import { renderBundle, writeBundleVerdict } from "@rinnegan/bundle_renderer.ts";
import { PHASE_FILE_SLUGS, SPEC_PHASE_EDGES, SPEC_PHASE_NODES } from "@rinnegan/phase-contract.ts";
import { field, pyInt, pyStr } from "@rinnegan/report-renderers/model.ts";
import type { Json } from "@rinnegan/report-renderers/model.ts";
import { isAuditOnly, validateNullFixCoverage } from "@rinnegan/run_pipeline_lib.ts";

export type ReportManifest = {
  version: number;
  authoritative_sources: Record<string, string>;
  canonical_paths: { master_audit: string; cross_cutting: string; progress: string; agent_instructions: string; layer_docs: string[]; phase_docs: string[] };
  required_outputs: { rinnegan: string[]; byakugan: string[] };
};

export type Stage = "rinnegan" | "byakugan";
export type PublicationVerdict = { ok: boolean; stage: Stage; errors: string[] };

const FIRST_FIX_PREVIEW_CHARS = 100;
const MAX_PLAN_ACTIONS = 4;
const MANIFEST_VERSION = 1;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

export const canonicalLayerDocRelPath = (layer: string): string => `layers/${layer}.md`;
export const canonicalPhaseDocRelPath = (phaseId: number): string => `phases/phase-${phaseId}-${PHASE_FILE_SLUGS[phaseId]}.md`;

function loadJson(path: string): Json | null {
  if (!isFile(path)) return null;
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

function phasePrerequisites(): Map<number, string[]> {
  const prerequisites = new Map<number, string[]>(SPEC_PHASE_NODES.map((node) => [node.id, []]));
  for (const edge of SPEC_PHASE_EDGES) prerequisites.get(edge.to)?.push(`phase-${edge.from}`);
  return prerequisites;
}

// Findings counted per integer phase; a finding without an integer phase is in none.
export function phaseCountsFromFindings(findings: readonly Json[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const finding of findings) {
    const phase = finding["phase"];
    if (typeof phase === "number" && Number.isInteger(phase)) counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return counts;
}

export const phaseTaskPath = (auditDir: string, phaseId: number): string => join(auditDir, "data", "tasks", `phase-${phaseId}-tasks.json`);

function taskSummary(task: Json): string {
  const targetCode = task["target_code"];
  if (typeof targetCode === "string" && pyStrip(targetCode) !== "") {
    const preview = pyStrip(pyStrip(targetCode).split(/\r\n|[\n\r]/)[0] ?? "");
    return `Replace with \`${preview.slice(0, FIRST_FIX_PREVIEW_CHARS)}\`.`;
  }
  const fixPlan = task["fix_plan"];
  if (Array.isArray(fixPlan) && fixPlan.length > 0) {
    const actions = (fixPlan as unknown[]).map((step) => field(step as Json, "action", "edit"));
    return `Plan: ${actions.slice(0, MAX_PLAN_ACTIONS).join(", ")}.`;
  }
  return "No deterministic replacement captured.";
}

const orText = (value: unknown, fallback: string): string => (isPyTruthy(value) ? pyStr(value) : fallback);

// Write one markdown document per remediation phase from its task file, and return their
// audit-relative paths in phase order.
export function generatePhaseDocs(auditDir: string): string[] {
  const phaseCounts = phaseCountsFromFindings(loadJsonl(join(auditDir, "data", "findings.jsonl")));
  const prerequisites = phasePrerequisites();
  mkdirSync(join(auditDir, "phases"), { recursive: true });

  return SPEC_PHASE_NODES.map((node) => {
    const taskData = loadJson(phaseTaskPath(auditDir, node.id));
    const hasData = taskData !== null && Object.keys(taskData).length > 0;
    const tasks = hasData && Array.isArray(taskData["tasks"]) ? (taskData["tasks"] as Json[]) : [];
    const verification = hasData && isRecord(taskData["verification"]) ? taskData["verification"] : {};
    const totalTasks = hasData ? tasks.length : (phaseCounts.get(node.id) ?? 0);
    const completed = hasData && Object.hasOwn(taskData, "completed") ? pyStr(taskData["completed"]) : "0";
    const status = hasData && isPyTruthy(taskData["status"]) ? pyStr(taskData["status"]) : totalTasks === 0 ? "clear" : "not_started";
    const headingName = hasData ? orText(taskData["phase_name"], `${node.name} (${node.rules.join(", ")})`) : `${node.name} (${node.rules.join(", ")})`;
    const declared = hasData ? taskData["prerequisites"] : undefined;
    const prerequisiteList = declared === undefined || declared === null ? (prerequisites.get(node.id) ?? []) : (declared as unknown[]).map(pyStr);

    const lines = [
      `# Phase ${node.id}: ${headingName}`,
      "",
      `> **Rules:** ${node.rules.join(", ")} | **Prerequisites:** ${prerequisiteList.length > 0 ? prerequisiteList.join(", ") : "None"}`,
      `> **Tasks:** ${totalTasks} | **Completed:** ${completed} | **Status:** ${status}`,
      "",
      "## Summary",
      "",
      `This phase covers \`${node.name}\` findings and is generated deterministically from task data.`,
      "",
      "## Verification",
      "",
    ];
    if (Object.keys(verification).length > 0) {
      lines.push(
        `- Command: \`${field(verification, "command", "echo MANUAL_REVIEW_REQUIRED")}\``,
        `- Expected: \`${field(verification, "expected", "")}\``,
        `- Description: ${field(verification, "description", "No verification description provided.")}`,
      );
    } else {
      lines.push("- Command: `echo MANUAL_REVIEW_REQUIRED`");
    }

    lines.push("", "## Tasks", "");
    if (tasks.length > 0) {
      lines.push("| ID | Severity | File | Line | Status |", "|----|----------|------|------|--------|");
      for (const task of tasks) lines.push(`| ${field(task, "id")} | ${field(task, "severity")} | \`${field(task, "file")}\` | ${field(task, "line")} | ${field(task, "status")} |`);
      lines.push("", "## Task Details", "");
      for (const task of tasks) {
        lines.push(
          `### ${field(task, "id")}`,
          "",
          `- File: \`${field(task, "file")}:${field(task, "line")}\``,
          `- Search pattern: \`${field(task, "search_pattern")}\``,
          `- Effort: \`${field(task, "effort")}\``,
          `- Explanation: ${field(task, "explanation")}`,
          `- Fix: ${taskSummary(task)}`,
          "",
        );
      }
    } else {
      lines.push("No findings are assigned to this phase.", "", "## Task Details", "", "This phase is currently clear.", "");
    }

    const relPath = canonicalPhaseDocRelPath(node.id);
    writeFileSync(join(auditDir, relPath), lines.join("\n").trimEnd() + "\n");
    return relPath;
  });
}

// Write the report manifest the validators and the report generators read.
export function generateReportManifest(auditDir: string): ReportManifest {
  const stats = loadJson(join(auditDir, "data", "audit-stats.json")) ?? {};
  const inventory = loadJson(join(auditDir, "data", "inventory.json")) ?? {};
  const statsLayers = Array.isArray(stats["layers"]) ? (stats["layers"] as Json[]) : [];
  let layerNames = statsLayers.map((layer) => field(layer, "name"));
  if (layerNames.length === 0) layerNames = Object.keys(isRecord(inventory["layers"]) ? inventory["layers"] : {}).sort();
  const layerDocs = layerNames.map(canonicalLayerDocRelPath);
  const phaseDocs = SPEC_PHASE_NODES.map((node) => canonicalPhaseDocRelPath(node.id));

  const manifest: ReportManifest = {
    version: MANIFEST_VERSION,
    authoritative_sources: {
      findings: "data/findings.jsonl",
      metrics: "data/audit-stats.json",
      phase_dag: "data/phase-dag.json",
      phase_tasks: "data/tasks/phase-*-tasks.json",
      clusters: "deep/clusters.json",
    },
    canonical_paths: {
      master_audit: "master-audit.md",
      cross_cutting: "cross-cutting.md",
      progress: "progress.md",
      agent_instructions: "agent-instructions.md",
      layer_docs: layerDocs,
      phase_docs: phaseDocs,
    },
    required_outputs: {
      rinnegan: [
        "master-audit.md",
        "cross-cutting.md",
        "progress.md",
        "agent-instructions.md",
        "data/findings.jsonl",
        "data/inventory.json",
        "data/phase-dag.json",
        "data/audit-stats.json",
        "data/report-manifest.json",
        ...layerDocs,
        ...phaseDocs,
      ],
      byakugan: [
        "deep/dependency-graph.json",
        "deep/clusters.json",
        "deep/impact-analysis.jsonl",
        "deep/narrative.md",
        "deep/scorecard.md",
        "deep/deployment-plan.md",
        "deep/executive-brief.md",
      ],
    },
  };
  mkdirSync(join(auditDir, "data"), { recursive: true });
  writeFileSync(join(auditDir, "data", "report-manifest.json"), dumpJson(manifest) + "\n");
  return manifest;
}

const LINK = /\[[^\]]+\]\(([^)]+)\)/g;
const ABSOLUTE_URL = /^[a-z]+:\/\//;

function extractRelativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(LINK)]
    .map((match) => match[1] ?? "")
    .filter((link) => link !== "" && !ABSOLUTE_URL.test(link))
    .map((link) => link.split("#")[0] ?? "");
}

const parseCount = (value: string): number => Number(value.replaceAll(",", "").trim());
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
const asRecord = (value: unknown): Json => (isRecord(value) ? value : {});
const statNumber = (stats: Json, key: string): number => pyInt(Object.hasOwn(stats, key) ? stats[key] : 0) ?? 0;
const statText = (stats: Json, key: string): string => pyStr(Object.hasOwn(stats, key) ? stats[key] : 0);
const SEVERITY_LEVELS: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"];
const MASTER_HEADER = /\*\*Files:\*\*\s*([\d,]+)\s*\|\s*\*\*LOC:\*\*\s*([\d,]+)\s*\|\s*\*\*Findings:\*\*\s*([\d,]+)/;
const SEVERITY_ROW = /^\|\s*(CRITICAL|HIGH|MEDIUM|LOW|REVIEW)\s*\|\s*([\d,]+)\s*\|/gm;
const LAYER_LINK = /layers\/([A-Za-z0-9_-]+\.md)/g;
const PHASE_ROW = /^\|\s*(\d+)\s*\|[^|\n]+\|\s*([\d,]+)\s*\|[^|\n]*\|\s*\[phase-\d+\]\((phases\/[^)]+)\)\s*\|?$/gm;

function validateMasterAudit(masterPath: string, stats: Json, layerNames: readonly string[]): string[] {
  if (!isFile(masterPath)) return ["master-audit.md missing"];
  const content = readTextStrict(masterPath).replace(/\r\n?/g, "\n");
  const errors: string[] = [];

  const header = MASTER_HEADER.exec(content);
  if (header === null) {
    errors.push("master-audit.md missing Files/LOC/Findings header");
  } else {
    const [files, loc, findings] = [1, 2, 3].map((index) => parseCount(header[index] ?? "0"));
    if (files !== statNumber(stats, "total_files")) errors.push(`master-audit.md files=${files} != audit-stats total_files=${statText(stats, "total_files")}`);
    if (loc !== statNumber(stats, "total_loc")) errors.push(`master-audit.md loc=${loc} != audit-stats total_loc=${statText(stats, "total_loc")}`);
    if (findings !== statNumber(stats, "total_findings")) errors.push(`master-audit.md findings=${findings} != audit-stats total_findings=${statText(stats, "total_findings")}`);
  }

  const severityRows = new Map<string, string>([...content.matchAll(SEVERITY_ROW)].map((match) => [match[1] ?? "", match[2] ?? "0"]));
  const expectedSeverity = asRecord(stats["severity"]);
  for (const level of SEVERITY_LEVELS) {
    const rendered = parseCount(severityRows.get(level) ?? "0");
    const expected = pyInt(Object.hasOwn(expectedSeverity, level) ? expectedSeverity[level] : 0) ?? 0;
    if (rendered !== expected) errors.push(`master-audit.md severity ${level}=${rendered} != audit-stats ${expected}`);
  }

  const renderedLayers = new Set([...content.matchAll(LAYER_LINK)].map((match) => match[1] ?? ""));
  for (const layerName of layerNames) {
    if (!renderedLayers.has(canonicalLayerDocRelPath(layerName).split("/").pop() ?? "")) errors.push(`master-audit.md missing canonical layer link for ${layerName}`);
  }

  const phaseRows = new Map<number, number>([...content.matchAll(PHASE_ROW)].map((match) => [Number(match[1]), parseCount(match[2] ?? "0")]));
  const statsPhaseCounts = new Map<number, number>(asList(stats["phases"]).map((entry) => [pyInt(asRecord(entry)["phase"]) ?? 0, pyInt(asRecord(entry)["findings"]) ?? 0]));
  for (let phaseId = 0; phaseId < SPEC_PHASE_NODES.length; phaseId += 1) {
    const rendered = phaseRows.get(phaseId);
    if (rendered === undefined) {
      errors.push(`master-audit.md missing phase row for phase ${phaseId}`);
      continue;
    }
    const expected = statsPhaseCounts.get(phaseId) ?? 0;
    if (rendered !== expected) errors.push(`master-audit.md phase ${phaseId} count=${rendered} != audit-stats ${expected}`);
  }
  return errors;
}

function validateStats(stats: Json, findings: readonly Json[], phaseCounts: ReadonlyMap<number, number>): string[] {
  const errors: string[] = [];
  if (Object.keys(stats).length === 0) return ["audit-stats.json missing or unreadable"];
  if (statNumber(stats, "total_findings") !== findings.length) {
    errors.push(`audit-stats total_findings=${statText(stats, "total_findings")} != findings.jsonl lines=${findings.length}`);
  }
  const severityCounts = new Map<string, number>();
  for (const finding of findings) severityCounts.set(field(finding, "severity", "MEDIUM"), (severityCounts.get(field(finding, "severity", "MEDIUM")) ?? 0) + 1);
  for (const [level, expected] of Object.entries(asRecord(stats["severity"]))) {
    if ((severityCounts.get(level) ?? 0) !== (pyInt(expected) ?? 0)) errors.push(`audit-stats severity ${level}=${pyStr(expected)} != findings-derived ${severityCounts.get(level) ?? 0}`);
  }
  const statsPhaseCounts = new Map<number, number>(asList(stats["phases"]).map((entry) => [pyInt(asRecord(entry)["phase"]) ?? 0, pyInt(asRecord(entry)["findings"]) ?? 0]));
  for (let phaseId = 0; phaseId < SPEC_PHASE_NODES.length; phaseId += 1) {
    const derived = phaseCounts.get(phaseId) ?? 0;
    const expected = statsPhaseCounts.get(phaseId) ?? 0;
    if (derived !== expected) errors.push(`audit-stats phase ${phaseId}=${expected} != findings-derived ${derived}`);
  }
  const affected = new Set(findings.map((finding) => field(finding, "file")).filter((file) => file !== "")).size;
  if (statNumber(stats, "affected_files") !== affected) errors.push(`audit-stats affected_files=${statText(stats, "affected_files")} != findings-derived ${affected}`);
  return errors;
}

function validatePhaseTasks(auditDir: string, phaseCounts: ReadonlyMap<number, number>): string[] {
  const errors: string[] = [];
  for (let phaseId = 0; phaseId < SPEC_PHASE_NODES.length; phaseId += 1) {
    const taskPath = phaseTaskPath(auditDir, phaseId);
    if (!isFile(taskPath)) {
      if ((phaseCounts.get(phaseId) ?? 0) > 0) errors.push(`missing phase task file for phase ${phaseId}`);
      continue;
    }
    const taskData = loadJson(taskPath) ?? {};
    const tasks = asList(taskData["tasks"]);
    const declared = pyInt(Object.hasOwn(taskData, "total_tasks") ? taskData["total_tasks"] : tasks.length) ?? 0;
    const relPath = `data/tasks/phase-${phaseId}-tasks.json`;
    if (declared !== tasks.length) errors.push(`${relPath} total_tasks=${declared} != actual tasks=${tasks.length}`);
    const derived = phaseCounts.get(phaseId) ?? 0;
    if (derived !== tasks.length) errors.push(`${relPath} tasks=${tasks.length} != findings-derived phase count=${derived}`);
  }
  return errors;
}

function validateClusters(auditDir: string, findings: readonly Json[]): string[] {
  const errors: string[] = [];
  const clusters = loadJson(join(auditDir, "deep", "clusters.json")) ?? {};
  const clusterIds = new Set(asList(clusters["clusters"]).map((cluster) => field(asRecord(cluster), "id", "")));
  if (clusterIds.size === 0) errors.push("clusters.json missing clusters");
  for (const finding of findings) {
    const clusterId = finding["cluster_id"];
    if (!isPyTruthy(clusterId)) errors.push(`finding ${field(finding, "id")} missing cluster_id`);
    else if (!clusterIds.has(pyStr(clusterId))) errors.push(`finding ${field(finding, "id")} references unknown cluster_id ${pyStr(clusterId)}`);
  }
  return errors;
}

function validateReferences(findings: readonly Json[], families: Json, qualityGate: Json): string[] {
  const errors: string[] = [];
  const rootIds = new Set(findings.filter((finding) => finding["is_root_cause"] === true).map((finding) => field(finding, "id")));
  const validIds = new Set(findings.map((finding) => field(finding, "id")));
  for (const finding of findings) {
    const parentId = finding["parent_finding_id"];
    if (!isPyTruthy(parentId)) continue;
    if (!validIds.has(pyStr(parentId))) errors.push(`finding ${field(finding, "id")} references missing parent_finding_id ${pyStr(parentId)}`);
    if (!rootIds.has(pyStr(parentId))) errors.push(`finding ${field(finding, "id")} parent_finding_id ${pyStr(parentId)} is not marked root cause`);
  }
  for (const family of asList(families["families"])) {
    const rootId = field(asRecord(family), "root_finding_id", "");
    if (rootId !== "" && !validIds.has(rootId)) errors.push(`family ${field(asRecord(family), "id")} references missing root finding ${rootId}`);
  }
  if (Object.keys(qualityGate).length === 0) return errors;
  for (const [tier, ids] of Object.entries(asRecord(qualityGate["blocker_explanation"]))) {
    if (!Array.isArray(ids)) {
      errors.push(`quality-gate blocker_explanation for ${tier} is not a list`);
      continue;
    }
    for (const id of ids as unknown[]) if (!validIds.has(pyStr(id))) errors.push(`quality-gate ${tier} blocker references missing finding id ${pyStr(id)}`);
  }
  for (const [tier, payload] of Object.entries(asRecord(qualityGate["tiers"]))) {
    if (isRecord(payload) && payload["status"] === "FAIL" && !isPyTruthy(payload["blocker_finding_ids"])) errors.push(`quality-gate tier ${tier} FAIL has no blocker_finding_ids`);
  }
  return errors;
}

// Validate the published bundle against the canonical contract and record the verdict.
export function validatePublicationContract(auditDir: string, stage: Stage = "rinnegan"): PublicationVerdict {
  const manifest: Json = loadJson(join(auditDir, "data", "report-manifest.json")) ?? { ...generateReportManifest(auditDir) };
  const required = asList(asRecord(manifest["required_outputs"])[stage]).map(pyStr);
  const errors: string[] = [];
  for (const relPath of required) if (!existsSync(join(auditDir, relPath))) errors.push(`missing required output: ${relPath}`);

  const findings = loadJsonl(join(auditDir, "data", "findings.jsonl"));
  const stats = loadJson(join(auditDir, "data", "audit-stats.json")) ?? {};
  const qualityGate = loadJson(join(auditDir, "data", "quality-gate.json")) ?? {};
  const families = loadJson(join(auditDir, "data", "finding-families.json")) ?? {};
  const nullFix = isAuditOnly(auditDir) ? undefined : validateNullFixCoverage(auditDir);
  if (nullFix?.triggered === true) errors.push(`null-fix contract violated: ${nullFix.null_fix_count}/${nullFix.non_review_count} non-REVIEW findings are missing both target_code and fix_plan`);

  const phaseCounts = phaseCountsFromFindings(findings);
  errors.push(...validateStats(stats, findings, phaseCounts));

  const layerNames = asList(stats["layers"]).map((layer) => field(asRecord(layer), "name"));
  if (stage === "rinnegan") errors.push(...validateMasterAudit(join(auditDir, "master-audit.md"), stats, layerNames));

  for (const name of ["master-audit.md", "cross-cutting.md"]) {
    const path = join(auditDir, name);
    if (!isFile(path)) continue;
    for (const link of extractRelativeLinks(readTextStrict(path))) {
      if (link !== "" && !existsSync(join(auditDir, link))) errors.push(`${name} has broken link: ${link}`);
    }
  }

  errors.push(...validatePhaseTasks(auditDir, phaseCounts));
  if (stage === "byakugan") errors.push(...validateClusters(auditDir, findings));
  errors.push(...validateReferences(findings, families, qualityGate));
  for (const relPath of renderBundle(auditDir, stage, true).mismatches) errors.push(`deterministic render drift: ${relPath}`);

  writeBundleVerdict(auditDir, stage, errors);
  return { ok: errors.length === 0, stage, errors };
}

const USAGE_EXIT_CODE = 1;

function main(argv: readonly string[]): number {
  const [command, auditDir, stageArg] = argv;
  if (command === undefined || auditDir === undefined) {
    console.log("Usage: report_contract.ts <phase-docs|manifest|validate> <audit_dir> [stage]");
    return USAGE_EXIT_CODE;
  }
  if (command === "phase-docs") {
    console.log(`Generated ${generatePhaseDocs(auditDir).length} phase docs`);
    return 0;
  }
  if (command === "manifest") {
    generateReportManifest(auditDir);
    console.log("Generated report-manifest.json");
    return 0;
  }
  if (command === "validate") {
    const stage = stageArg ?? "rinnegan";
    const result = validatePublicationContract(auditDir, stage === "byakugan" ? "byakugan" : "rinnegan");
    if (result.ok) {
      console.log(`PUBLICATION_VALID: ${stage}`);
      return 0;
    }
    console.log(`PUBLICATION_INVALID: ${stage}`);
    for (const error of result.errors) console.log(`- ${error}`);
    return USAGE_EXIT_CODE;
  }
  console.log(`Unknown command: ${command}`);
  return USAGE_EXIT_CODE;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
