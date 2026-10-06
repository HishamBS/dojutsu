// Shared pipeline steps for rinnegan, kept free of side effects so tests can import them:
// the phase DAG and Rasengan configuration the pipeline writes deterministically.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { universalLines, pyStrip } from "@quality/py-text.ts";
import { evaluateQualityGate } from "@rinnegan/quality_gate.ts";
import type { QualityGateResult } from "@rinnegan/quality_gate.ts";
import { isPhaseNumber, RASENGAN_CONFIG_DEFAULTS, SPEC_PHASE_EDGES, SPEC_PHASE_NODES } from "@rinnegan/phase-contract.ts";
import type { PhaseEdge } from "@rinnegan/phase-contract.ts";

type Json = Record<string, unknown>;

export type PhaseDag = { nodes: { id: number; name: string; rules: string[]; finding_count: number }[]; edges: PhaseEdge[] };
export type NullFixResult = { triggered: boolean; null_fix_count: number; non_review_count: number; percent: number };
export type RasenganConfig = { project_dir: string; audit_dir: string; stack: string; framework: string } & typeof RASENGAN_CONFIG_DEFAULTS;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

// An audit-only run skips enrichment, so its findings carry no fix output to validate; the marker
// persists across pipeline re-entry.
export const auditOnlyMarkerPath = (auditDir: string): string => join(auditDir, "data", ".audit-only");
export const isAuditOnly = (auditDir: string): boolean => isFile(auditOnlyMarkerPath(auditDir));

// A data file that must be a JSON object when present; an absent one is empty.
function loadRecordOrEmpty(path: string): Json {
  if (!isFile(path)) return {};
  const parsed: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(parsed)) throw new TypeError(`${path}: expected a JSON object`);
  return parsed;
}

function countFindingsPerPhase(auditDir: string): Map<number, number> {
  const counts = new Map<number, number>();
  const path = join(auditDir, "data", "findings.jsonl");
  if (!isFile(path)) return counts;
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const finding: unknown = JSON.parse(stripped);
    if (!isRecord(finding)) throw new TypeError(`${path}: a row is not a JSON object`);
    const phase = finding["phase"];
    if (isPhaseNumber(phase)) counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return counts;
}

const PERCENT = 100;

// Every non-REVIEW finding must carry a target_code or a non-empty fix_plan list. Any that
// carries neither triggers the gate.
export function validateNullFixCoverage(auditDir: string): NullFixResult {
  const path = join(auditDir, "data", "findings.jsonl");
  let nonReview = 0;
  let nullFix = 0;
  if (isFile(path)) {
    for (const line of universalLines(readTextStrict(path))) {
      const stripped = pyStrip(line);
      if (stripped === "") continue;
      const finding: unknown = JSON.parse(stripped);
      if (!isRecord(finding)) throw new TypeError(`${path}: a row is not a JSON object`);
      if (finding["severity"] === "REVIEW") continue;
      nonReview += 1;
      const target = finding["target_code"];
      const plan = finding["fix_plan"];
      const hasTarget = target !== undefined && target !== null && target !== "";
      const hasPlan = Array.isArray(plan) && plan.length > 0;
      if (!hasTarget && !hasPlan) nullFix += 1;
    }
  }
  if (nonReview === 0) return { triggered: false, null_fix_count: 0, non_review_count: 0, percent: 0 };
  return { triggered: nullFix > 0, null_fix_count: nullFix, non_review_count: nonReview, percent: (nullFix / nonReview) * PERCENT };
}

// Write the spec phase-dag.json, each node annotated with its finding count.
function generatePhaseDag(auditDir: string): PhaseDag {
  const counts = countFindingsPerPhase(auditDir);
  const dag: PhaseDag = {
    nodes: SPEC_PHASE_NODES.map((node) => ({ id: node.id, name: node.name, rules: [...node.rules], finding_count: counts.get(node.id) ?? 0 })),
    edges: SPEC_PHASE_EDGES.map((edge) => ({ from: edge.from, to: edge.to })),
  };
  mkdirSync(join(auditDir, "data"), { recursive: true });
  writeFileSync(join(auditDir, "data", "phase-dag.json"), dumpJson(dag) + "\n");
  return dag;
}

const metadataText = (primary: Json, fallback: Json, key: string): string => {
  const own = primary[key];
  if (own !== undefined) return typeof own === "string" ? own : JSON.stringify(own);
  const inherited = fallback[key];
  return typeof inherited === "string" ? inherited : "unknown";
};

// Write rasengan-config.json: project metadata from config.json or the inventory, then the
// spec defaults, which no other output overrides.
function generateRasenganConfig(auditDir: string, projectDir: string): RasenganConfig {
  const inventory = loadRecordOrEmpty(join(auditDir, "data", "inventory.json"));
  const config = loadRecordOrEmpty(join(auditDir, "data", "config.json"));
  const result: RasenganConfig = {
    project_dir: projectDir,
    audit_dir: auditDir,
    stack: metadataText(config, inventory, "stack"),
    framework: metadataText(config, inventory, "framework"),
    ...RASENGAN_CONFIG_DEFAULTS,
  };
  mkdirSync(join(auditDir, "data"), { recursive: true });
  writeFileSync(join(auditDir, "data", "rasengan-config.json"), dumpJson(result) + "\n");
  return result;
}

// Generate both phase-dag.json and rasengan-config.json deterministically.
export function generateDagAndConfig(auditDir: string, projectDir: string): { dag: PhaseDag; config: RasenganConfig } {
  return { dag: generatePhaseDag(auditDir), config: generateRasenganConfig(auditDir, projectDir) };
}

// Evaluate the quality gates from an audit directory: its findings, and its health report
// when one was written.
export function evaluateQualityGateFromAudit(auditDir: string, thresholds?: Record<string, number>): QualityGateResult {
  const healthPath = join(auditDir, "data", "pipeline-health.json");
  return evaluateQualityGate(join(auditDir, "data", "findings.jsonl"), {
    ...(isFile(healthPath) ? { healthPath } : {}),
    ...(thresholds === undefined ? {} : { thresholds }),
    auditDir,
  });
}
