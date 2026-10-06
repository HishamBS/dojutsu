// The bundle model every audit document is rendered from, and the formatting rules the
// renderers share. Python-era documents print values the way Python's str() does, so these
// helpers reproduce that form: floats keep a ".0", None prints as "None".
import { pyRound } from "@quality/py-round.ts";

export type Json = Record<string, unknown>;

export type LayerDoc = { name: string; files: unknown[]; loc: number; findings: Json[]; path: string };
export type PhaseDoc = { phase: number; name: string; path: string; tasks: number; status: unknown };
export type CrossCuttingGroup = { name: string; instances: Json[]; count: number; layers: string[]; highest_severity: string; rule: string };
export type ClusterSummary = {
  id: string;
  name: string;
  type: string;
  rules: unknown[];
  finding_count: number;
  max_severity: string;
  root_pattern: string;
  files: unknown[];
  finding_ids: unknown[];
  impact_rows: Json[];
  cluster_narrative: unknown;
  recommended_approach: unknown;
};

export type BundleModel = {
  generated_at: string;
  project_name: string;
  stack: string;
  framework: string;
  total_files_scanned: number;
  total_loc: number;
  total_findings: number;
  affected_files: string[];
  affected_file_count: number;
  severity: Json;
  categories: unknown[];
  layers: LayerDoc[];
  phases: PhaseDoc[];
  cross_cutting_groups: CrossCuttingGroup[];
  critical_findings: Json[];
  must_fix_ids: string[];
  quality_gate: Json;
  blocker_finding_ids: Record<string, string[]>;
  families: unknown[];
  clusters: ClusterSummary[];
  report_manifest: Json;
  readiness_score: number;
  finding_index: Record<string, Json>;
  cluster_index: Record<string, Json>;
  impact_rows: Json[];
};

export const SEVERITY_ORDER: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, REVIEW: 4 };
export const UNKNOWN_SEVERITY_RANK = 99;
export const SEVERITY_LEVELS: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"];
export const DEFAULT_PHASE = 10;

const PERCENT = 100;
const PERCENT_DIGITS = 1;

export function severityRank(severity: string): number {
  return Object.hasOwn(SEVERITY_ORDER, severity) ? (SEVERITY_ORDER[severity] ?? UNKNOWN_SEVERITY_RANK) : UNKNOWN_SEVERITY_RANK;
}

// A float as Python prints it: a whole number keeps its ".0".
export const pyFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));

// str(value) for a JSON value; None prints as "None".
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "None";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

// finding.get(key, fallback) followed by str(): a present null prints as "None".
export const field = (row: Json, key: string, fallback: unknown = ""): string => pyStr(Object.hasOwn(row, key) ? row[key] : fallback);

// int(value) for a JSON value, or undefined where Python's int() would raise.
export function pyInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  return undefined;
}

// int(value) where a non-integer is a corrupt document and stops the render.
export function requireInt(value: unknown, where: string): number {
  const parsed = pyInt(value);
  if (parsed === undefined) throw new TypeError(`${where}: not an integer`);
  return parsed;
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0.0;
  return pyRound((numerator / denominator) * PERCENT, PERCENT_DIGITS);
}

// The phase a finding belongs to in a rendered table: its phase as an integer, default 10.
export const renderedPhase = (finding: Json): number => requireInt(Object.hasOwn(finding, "phase") ? finding["phase"] : DEFAULT_PHASE, `finding ${field(finding, "id")} phase`);

export function severityKey(finding: Json): [number, string, number, string] {
  const severity = Object.hasOwn(finding, "severity") ? pyStr(finding["severity"]) : "MEDIUM";
  return [severityRank(severity), field(finding, "file"), pyInt(finding["line"] ?? 0) ?? 0, field(finding, "id")];
}

export function compareSeverityKeys(a: Json, b: Json): number {
  const [aRank, aFile, aLine, aId] = severityKey(a);
  const [bRank, bFile, bLine, bId] = severityKey(b);
  return aRank - bRank || (aFile < bFile ? -1 : aFile > bFile ? 1 : 0) || aLine - bLine || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

export function recommendationFromGate(qualityGate: Json, mustFixCount: number): string {
  const overall = pyStr(Object.hasOwn(qualityGate, "overall") ? qualityGate["overall"] : "FAIL");
  if (overall === "FAIL") {
    return `Do not begin remediation until the ${mustFixCount} must-fix findings are assigned by phase and the published bundle remains validator-clean after every rerender.`;
  }
  if (overall === "CONDITIONAL") {
    return `Proceed with remediation, but keep must-fix work ahead of code-hygiene cleanup. ${mustFixCount} findings still require deliberate sequencing.`;
  }
  return "The bundle is internally consistent. Use phase tasks and cluster guidance to remediate in order.";
}
