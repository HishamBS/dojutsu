#!/usr/bin/env bun
// Usage: compute_audit_stats.ts <audit_dir>
// Computes the deterministic audit statistics from the pipeline data files and writes
// data/audit-stats.json: the single source of truth for every number in a generated report.
// Report generators use these values and never count raw data themselves.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso } from "@quality/py-format.ts";
import { pyRound } from "@quality/py-round.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";

export const PHASE_NAMES: Readonly<Record<number, string>> = {
  0: "Foundation / Build",
  1: "Security",
  2: "Typing Discipline",
  3: "SSOT / DRY",
  4: "Architecture / Layering",
  5: "Clean Code",
  6: "Performance",
  7: "Data Integrity",
  8: "Refactoring",
  9: "Full-Stack Alignment",
  10: "Documentation",
};

export const RULE_NAMES: Readonly<Record<string, string>> = {
  R01: "SSOT & DRY",
  R02: "Separation of Concerns",
  R03: "Mirror Architecture",
  R04: "Performance First",
  R05: "Security",
  R07: "Strict Typing",
  R08: "Build/Test Gate",
  R09: "Clean Code",
  R10: "Whole-System Refactors",
  R11: "Documentation",
  R12: "Real Data",
  R13: "No Magic Numbers",
  R14: "Clean Build",
  R16: "Full Stack Verification",
};

// Severity levels in canonical order.
export const SEVERITY_LEVELS: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"];

const DEFAULT_SEVERITY = "MEDIUM";
const HOTSPOT_LIMIT = 10;
const MIN_KLOC = 0.1;
const LOC_PER_KLOC = 1000;
const PERCENT = 100;
const DENSITY_DIGITS = 1;
const USAGE_EXIT_CODE = 1;

type Json = Record<string, unknown>;

export type CategoryStat = { name: string; count: number; critical: number; high: number; medium: number; low: number; review: number };
export type LayerStat = { name: string; files: number; loc: number; findings: number; density_per_kloc: number };
export type PhaseStat = { phase: number; name: string; findings: number; critical: number; high: number };

export type AuditStats = {
  generated_at: string;
  audit_date: string;
  project_name: string;
  stack: string;
  framework: string;
  total_files: number;
  total_loc: number;
  total_findings: number;
  total_raw_findings: number;
  dedup_count: number;
  affected_files: number;
  severity: Record<string, number>;
  categories: CategoryStat[];
  layers: LayerStat[];
  phases: PhaseStat[];
  hotspots: { file: string; findings: number }[];
  cross_cutting: { total_findings_in_groups: number; total_groups: number; percent_cross_cutting: number };
  quality_gate: unknown;
  pipeline_health: unknown;
  enrichment: { has_target_code: number; has_fix_plan: number; has_either: number; has_neither: number; enrichment_rate_percent: number };
  scanners: { name: string; count: number }[];
  rules: { rule: string; count: number; name: string }[];
  clusters: { total_clusters: number; ids: string[] };
  families: { families_created: number; root_causes: number; subordinate_findings: number };
};

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

// One row per non-blank line; a row that is not a JSON object stops the audit.
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

// A JSON file, or null when it is missing or not parsable.
function loadJson(path: string): unknown {
  if (!isFile(path)) return null;
  try {
    return JSON.parse(readTextStrict(path));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function loadRecord(path: string): Json | null {
  const loaded = loadJson(path);
  if (loaded === null) return null;
  if (!isRecord(loaded)) throw new TypeError(`${path}: expected a JSON object`);
  return loaded;
}

// str(value) for a JSON value, with a missing one as the empty string.
const plainText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);

const text = (row: Json, key: string, fallback: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
};

const severityOf = (row: Json): string => text(row, "severity", DEFAULT_SEVERITY);

// Group rows by a key, keeping the order in which each key first appears.
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

// Counter.most_common(): descending by count, ties in first-seen order.
function countBy(rows: readonly Json[], keyOf: (row: Json) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function severityCounts(findings: readonly Json[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(SEVERITY_LEVELS.map((level) => [level, 0]));
  for (const row of findings) {
    const severity = severityOf(row);
    if (SEVERITY_LEVELS.includes(severity)) counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

function severityTally(members: readonly Json[], level: string): number {
  return members.filter((member) => severityOf(member) === level).length;
}

function categoryBreakdown(findings: readonly Json[]): CategoryStat[] {
  const stats = [...groupBy(findings, (row) => text(row, "category", "uncategorized")).entries()].map(([name, members]) => ({
    name: String(name),
    count: members.length,
    critical: severityTally(members, "CRITICAL"),
    high: severityTally(members, "HIGH"),
    medium: severityTally(members, "MEDIUM"),
    low: severityTally(members, "LOW"),
    review: severityTally(members, "REVIEW"),
  }));
  return stats.sort((a, b) => b.count - a.count);
}

function layerBreakdown(findings: readonly Json[], inventory: Json | null): LayerStat[] {
  const layersInventory = inventory === null ? {} : inventory["layers"];
  const known = isRecord(layersInventory) ? layersInventory : {};
  const stats = [...groupBy(findings, (row) => text(row, "layer", "unknown")).entries()].map(([name, members]) => {
    const layer = known[String(name)];
    const data = isRecord(layer) ? layer : {};
    const files = Array.isArray(data["files"]) ? data["files"].length : 0;
    const loc = typeof data["loc"] === "number" ? data["loc"] : 0;
    const density = loc > 0 ? pyRound(members.length / Math.max(loc / LOC_PER_KLOC, MIN_KLOC), DENSITY_DIGITS) : 0;
    return { name: String(name), files, loc, findings: members.length, density_per_kloc: density };
  });
  return stats.sort((a, b) => b.findings - a.findings);
}

// A phase is an integer; a numeric string parses and anything else is phase 0.
function phaseOf(row: Json): number {
  const phase = row["phase"];
  if (typeof phase === "number") return phase;
  if (typeof phase === "string" && /^\s*[+-]?\d+\s*$/.test(phase)) return Number(phase);
  return 0;
}

function phaseBreakdown(findings: readonly Json[]): PhaseStat[] {
  const byPhase = groupBy(findings, phaseOf);
  return [...byPhase.keys()]
    .map(Number)
    .sort((a, b) => a - b)
    .map((phase) => {
      const members = byPhase.get(phase) ?? [];
      return { phase, name: PHASE_NAMES[phase] ?? `Phase ${phase}`, findings: members.length, critical: severityTally(members, "CRITICAL"), high: severityTally(members, "HIGH") };
    });
}

function crossCuttingStats(findings: readonly Json[]): AuditStats["cross_cutting"] {
  const groups = new Set<string>();
  let inGroup = 0;
  for (const row of findings) {
    if (!isPyTruthy(row["cross_cutting"])) continue;
    inGroup += 1;
    const group = text(row, "cross_cutting_group", "");
    if (group !== "") groups.add(group);
  }
  return {
    total_findings_in_groups: inGroup,
    total_groups: groups.size,
    percent_cross_cutting: pyRound((inGroup / Math.max(findings.length, 1)) * PERCENT, 1),
  };
}

function enrichmentStats(findings: readonly Json[]): AuditStats["enrichment"] {
  let hasTarget = 0;
  let hasFix = 0;
  let hasEither = 0;
  for (const row of findings) {
    const target = isPyTruthy(row["current_code"]) || isPyTruthy(row["target_code"]);
    const plan = isPyTruthy(row["fix_plan"]);
    if (target) hasTarget += 1;
    if (plan) hasFix += 1;
    if (target || plan) hasEither += 1;
  }
  return {
    has_target_code: hasTarget,
    has_fix_plan: hasFix,
    has_either: hasEither,
    has_neither: findings.length - hasEither,
    enrichment_rate_percent: pyRound((hasEither / Math.max(findings.length, 1)) * PERCENT, 1),
  };
}

function clusterStats(auditDir: string): AuditStats["clusters"] {
  const clusters = loadRecord(join(auditDir, "deep", "clusters.json")) ?? {};
  const items = Array.isArray(clusters["clusters"]) ? (clusters["clusters"] as unknown[]) : [];
  const ids = items.map((cluster) => {
    if (!isRecord(cluster)) throw new TypeError("clusters.json: a cluster is not an object");
    return plainText(cluster["id"]);
  });
  return { total_clusters: items.length, ids: ids.filter((id) => id !== "") };
}

function familyStats(auditDir: string): AuditStats["families"] {
  const families = loadRecord(join(auditDir, "data", "finding-families.json")) ?? {};
  const summaryValue = families["summary"];
  const summary = isRecord(summaryValue) ? summaryValue : {};
  const count = (key: string): number => {
    const value = summary[key];
    return typeof value === "number" ? Math.trunc(value) : 0;
  };
  return { families_created: count("families_created"), root_causes: count("root_causes"), subordinate_findings: count("subordinate_findings") };
}

const localDate = (): string => {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// Every statistic a report generator needs, from data/findings.jsonl, inventory.json,
// pipeline-health.json, quality-gate.json and config.json (project metadata only).
export function computeStats(auditDir: string): AuditStats {
  const dataDir = join(auditDir, "data");
  const findings = loadJsonl(join(dataDir, "findings.jsonl"));
  const inventory = loadRecord(join(dataDir, "inventory.json"));
  const health = loadJson(join(dataDir, "pipeline-health.json"));
  const qualityGate = loadJson(join(dataDir, "quality-gate.json"));
  const config = loadRecord(join(dataDir, "config.json"));
  const inv = inventory ?? {};
  const metadata = (key: string): string => text(config ?? {}, key, text(inv, key, "unknown"));
  const count = (key: string): number => (typeof inv[key] === "number" ? inv[key] : 0);
  const affected = new Set(findings.map((row) => plainText(row["file"])).filter((file) => file !== ""));

  return {
    generated_at: nowIso(),
    audit_date: localDate(),
    project_name: text(inv, "root", "unknown"),
    stack: metadata("stack"),
    framework: metadata("framework"),
    total_files: count("total_files"),
    total_loc: count("total_loc"),
    total_findings: findings.length,
    total_raw_findings: findings.length,
    dedup_count: 0,
    affected_files: affected.size,
    severity: severityCounts(findings),
    categories: categoryBreakdown(findings),
    layers: layerBreakdown(findings, inventory),
    phases: phaseBreakdown(findings),
    hotspots: countBy(findings, (row) => text(row, "file", "unknown")).slice(0, HOTSPOT_LIMIT).map(([file, n]) => ({ file, findings: n })),
    cross_cutting: crossCuttingStats(findings),
    quality_gate: isPyTruthy(qualityGate) ? qualityGate : {},
    pipeline_health: isPyTruthy(health) ? health : {},
    enrichment: enrichmentStats(findings),
    scanners: countBy(findings, (row) => text(row, "scanner", "unknown")).map(([name, n]) => ({ name, count: n })),
    rules: countBy(findings, (row) => text(row, "rule", "UNKNOWN")).map(([rule, n]) => ({ rule, count: n, name: RULE_NAMES[rule] ?? rule })),
    clusters: clusterStats(auditDir),
    families: familyStats(auditDir),
  };
}

// Compute the statistics and write them to <audit_dir>/data/audit-stats.json.
export function writeStats(auditDir: string): string {
  const stats = computeStats(auditDir);
  const outputPath = join(auditDir, "data", "audit-stats.json");
  mkdirSync(join(auditDir, "data"), { recursive: true });
  writeFileSync(outputPath, dumpJson(stats) + "\n");
  return outputPath;
}

if (import.meta.main) {
  const auditDir = process.argv[2];
  if (auditDir === undefined) {
    console.log("Usage: compute_audit_stats.ts <audit_dir>");
    process.exit(USAGE_EXIT_CODE);
  }
  console.log(`Stats written to ${writeStats(auditDir)}`);
}
