// Quality gate engine: reads the findings and the pipeline health report and produces a
// per-tier pass/warn/fail verdict, a readiness score and, when an audit directory is given,
// the quality-gate.json record and the readiness trend.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { pyRound } from "@quality/py-round.ts";
import { pyStrip, universalLines } from "@quality/py-text.ts";
import { appendTrend, getTrend } from "@rinnegan/readiness_trend.ts";
import type { TrendInfo } from "@rinnegan/readiness_trend.ts";

type Json = Record<string, unknown>;
type TierStatus = "PASS" | "WARN" | "FAIL";

export type TierResult = { status: TierStatus; details: string; blocker_finding_ids: string[] };
export type QualitySummary = { total_findings: number; critical: number; high: number; medium: number; low: number; tools_run: number };
export type QualityGateResult = {
  readiness_score: number;
  overall: "PASS" | "CONDITIONAL" | "FAIL";
  tiers: Record<string, TierResult>;
  summary: QualitySummary;
  trend: TrendInfo | null;
  blocker_explanation: Record<string, string[]>;
};
export type QualityOptions = { healthPath?: string; thresholds?: Record<string, number>; totalLoc?: number; auditDir?: string };

export const TIERS: Readonly<Record<string, { name: string; rules: readonly string[] }>> = {
  build: { name: "Build & Lint", rules: ["R14"] },
  security: { name: "Security", rules: ["R05"] },
  secrets: { name: "Secrets & Env", rules: ["R05-gitleaks", "R12-env"] },
  coverage: { name: "Test Coverage", rules: ["R08"] },
  duplication: { name: "Code Duplication", rules: ["R01"] },
  complexity: { name: "Complexity & Dead Code", rules: ["R02", "R09"] },
  architecture: { name: "Architecture", rules: ["R02", "R03", "R10"] },
};

export const DEFAULT_THRESHOLDS: Readonly<Record<string, number>> = {
  max_critical_vulns: 0,
  max_high_vulns: 0,
  max_secrets: 0,
  min_line_coverage: 60,
  max_duplication_pct: 5.0,
  max_cyclomatic_complexity: 20,
  readiness_threshold: 80,
};

// Weights of the readiness score; a severity without a weight (REVIEW) counts as one.
export const SEVERITY_WEIGHTS: Readonly<Record<string, number>> = { CRITICAL: 10.0, HIGH: 3.0, MEDIUM: 1.0, LOW: 0.2 };

const DEFAULT_SEVERITY = "MEDIUM";
const DEFAULT_WEIGHT = 1.0;
const MAX_WARN_BUILD_ERRORS = 5;
const CLOSE_TO_THRESHOLD = 0.8;
const ELEVATED_DUPLICATION = 1.5;
const MIN_KLOC = 1.0;
const LOC_PER_KLOC = 1000;
const FULL_SCORE = 100.0;
const SCORE_DIGITS = 2;
const PERCENT_DIGITS = 1;
const BLOCKING: readonly string[] = ["CRITICAL", "HIGH"];

const text = (row: Json, key: string, fallback: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
};
const severityOf = (row: Json): string => text(row, "severity", DEFAULT_SEVERITY);
const idOf = (row: Json): string => {
  const id = row["id"];
  return typeof id === "string" ? id : id === undefined ? "" : JSON.stringify(id);
};

// "{:.1f}" of a number
const fixed1 = (value: number): string => pyRound(value, PERCENT_DIGITS).toFixed(PERCENT_DIGITS);
// repr of a float threshold: whole numbers keep their ".0"
const floatText = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function loadFindings(path: string): Json[] {
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

function loadRecord(path: string | undefined): Json | null {
  if (path === undefined || !isFile(path)) return null;
  const parsed: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(parsed)) throw new TypeError(`${path}: expected a JSON object`);
  return parsed;
}

const countBySeverity = (findings: readonly Json[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const row of findings) counts.set(severityOf(row), (counts.get(severityOf(row)) ?? 0) + 1);
  return counts;
};

// 100 - weighted findings per KLOC, clamped to [0, 100]; a project under one KLOC counts as one.
function computeReadinessScore(findings: readonly Json[], totalLoc: number): number {
  const kloc = Math.max(totalLoc / LOC_PER_KLOC, MIN_KLOC);
  const weighted = findings.reduce((sum, row) => sum + (Object.hasOwn(SEVERITY_WEIGHTS, severityOf(row)) ? (SEVERITY_WEIGHTS[severityOf(row)] ?? DEFAULT_WEIGHT) : DEFAULT_WEIGHT), 0);
  return pyRound(Math.max(0, Math.min(FULL_SCORE, FULL_SCORE - weighted / kloc)), SCORE_DIGITS);
}

// A finding belongs to a tier by its rule: an exact match, or the rule starts with a tier
// rule's own part before any "-" suffix.
function tierFindings(findings: readonly Json[], tierRules: readonly string[]): Json[] {
  return findings.filter((row) => {
    const rule = text(row, "rule", "");
    return tierRules.some((tierRule) => rule === tierRule || rule.startsWith(tierRule.split("-")[0] ?? tierRule));
  });
}

const blockers = (rows: readonly Json[], severities: readonly string[]): string[] => rows.filter((row) => severities.includes(severityOf(row))).map(idOf);
const tierResult = (status: TierStatus, details: string, blockerIds: string[] = []): TierResult => ({ status, details, blocker_finding_ids: blockerIds });
const tally = (counts: ReadonlyMap<string, number>, severity: string): number => counts.get(severity) ?? 0;
const threshold = (thresholds: Readonly<Record<string, number>>, key: string): number => thresholds[key] ?? DEFAULT_THRESHOLDS[key] ?? 0;

function evaluateBuildTier(findings: readonly Json[]): TierResult {
  const tierRows = tierFindings(findings, TIERS["build"]?.rules ?? []);
  const counts = countBySeverity(tierRows);
  const critical = tally(counts, "CRITICAL");
  const high = tally(counts, "HIGH");
  const errors = critical + high;
  if (errors === 0) return tierResult("PASS", `0 type errors, 0 lint errors (${tierRows.length} total build findings)`);
  const details = `${errors} build errors (${critical} critical, ${high} high)`;
  if (errors <= MAX_WARN_BUILD_ERRORS) return tierResult("WARN", details);
  return tierResult("FAIL", details, blockers(tierRows, BLOCKING));
}

function evaluateSecurityTier(findings: readonly Json[], thresholds: Readonly<Record<string, number>>): TierResult {
  const tierRows = tierFindings(findings, TIERS["security"]?.rules ?? []);
  const counts = countBySeverity(tierRows);
  const critical = tally(counts, "CRITICAL");
  const high = tally(counts, "HIGH");
  const maxCritical = threshold(thresholds, "max_critical_vulns");
  const maxHigh = threshold(thresholds, "max_high_vulns");
  if (critical > maxCritical) return tierResult("FAIL", `${critical} CRITICAL vulnerabilities (max ${maxCritical})`, blockers(tierRows, ["CRITICAL"]));
  if (high > maxHigh) return tierResult("FAIL", `${high} HIGH vulnerabilities (max ${maxHigh})`, blockers(tierRows, BLOCKING));
  if (critical + high > 0) return tierResult("WARN", `${critical} critical, ${high} high vulnerabilities (within thresholds)`);
  return tierResult("PASS", "0 security vulnerabilities");
}

function evaluateSecretsTier(findings: readonly Json[], thresholds: Readonly<Record<string, number>>): TierResult {
  const tierRows = tierFindings(findings, TIERS["secrets"]?.rules ?? []);
  const maxSecrets = threshold(thresholds, "max_secrets");
  const secretCount = tierRows.filter((row) => BLOCKING.includes(severityOf(row))).length;
  if (secretCount > maxSecrets) return tierResult("FAIL", `${secretCount} secrets/env issues detected (max ${maxSecrets})`, blockers(tierRows, BLOCKING));
  if (tierRows.length > 0) return tierResult("WARN", `${tierRows.length} env-related findings (no critical secrets)`);
  return tierResult("PASS", "No secrets or env issues detected");
}

function numberFrom(health: Json, key: string): number {
  const value = health[key];
  if (typeof value !== "number") throw new TypeError(`pipeline-health.json: ${key} is not a number`);
  return value;
}

function evaluateCoverageTier(health: Json | null, thresholds: Readonly<Record<string, number>>): TierResult {
  const minCoverage = threshold(thresholds, "min_line_coverage");
  if (health === null || !("coverage_line_pct" in health)) return tierResult("WARN", "No coverage data available");
  const coverage = numberFrom(health, "coverage_line_pct");
  if (coverage >= minCoverage) return tierResult("PASS", `${fixed1(coverage)}% line coverage (threshold ${minCoverage}%)`);
  if (coverage >= minCoverage * CLOSE_TO_THRESHOLD) return tierResult("WARN", `${fixed1(coverage)}% line coverage (threshold ${minCoverage}%, close)`);
  return tierResult("FAIL", `${fixed1(coverage)}% line coverage (below ${minCoverage}% threshold)`);
}

function evaluateDuplicationTier(findings: readonly Json[], health: Json | null, thresholds: Readonly<Record<string, number>>): TierResult {
  const maxDuplication = threshold(thresholds, "max_duplication_pct");
  if (health === null || !("duplication_pct" in health)) return tierResult("WARN", "No duplication data available");
  const duplication = numberFrom(health, "duplication_pct");
  const limit = floatText(maxDuplication);
  if (duplication <= maxDuplication) return tierResult("PASS", `${fixed1(duplication)}% duplication (max ${limit}%)`);
  if (duplication <= maxDuplication * ELEVATED_DUPLICATION) return tierResult("WARN", `${fixed1(duplication)}% duplication (max ${limit}%, elevated)`);
  const dryBlockers = findings.filter((row) => text(row, "rule", "") === "R01" && BLOCKING.includes(severityOf(row))).map(idOf);
  return tierResult("FAIL", `${fixed1(duplication)}% duplication (exceeds ${limit}% threshold)`, dryBlockers);
}

// The complexity and architecture tiers share one shape: any critical or high finding fails.
function evaluateRuleTier(findings: readonly Json[], tier: string, noun: string, none: string): TierResult {
  const tierRows = tierFindings(findings, TIERS[tier]?.rules ?? []);
  const counts = countBySeverity(tierRows);
  const highCount = tally(counts, "CRITICAL") + tally(counts, "HIGH");
  if (highCount === 0 && tierRows.length === 0) return tierResult("PASS", none);
  if (highCount === 0) return tierResult("WARN", `${tierRows.length} ${noun} findings (none critical/high)`);
  return tierResult("FAIL", `${highCount} high-severity ${noun} ${noun === "complexity" ? "issues" : "violations"} out of ${tierRows.length} total`, blockers(tierRows, BLOCKING));
}

function computeOverall(tiers: Readonly<Record<string, TierResult>>): QualityGateResult["overall"] {
  const statuses = Object.values(tiers).map((tier) => tier.status);
  if (statuses.includes("FAIL")) return "FAIL";
  return statuses.includes("WARN") ? "CONDITIONAL" : "PASS";
}

function resolveTotalLoc(options: QualityOptions): number {
  if ((options.totalLoc ?? 0) > 0) return options.totalLoc ?? 0;
  if (options.auditDir === undefined) return 0;
  const inventory = loadRecord(join(options.auditDir, "data", "inventory.json"));
  const loc = inventory?.["total_loc"];
  return typeof loc === "number" ? loc : 0;
}

// Evaluate every tier for the findings at `findingsPath` and return the verdict. With an
// audit directory the verdict is also written to data/quality-gate.json and the readiness
// trend is updated.
export function evaluateQualityGate(findingsPath: string, options: QualityOptions = {}): QualityGateResult {
  const thresholds: Record<string, number> = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const findings = loadFindings(findingsPath);
  const health = loadRecord(options.healthPath);
  const readiness = computeReadinessScore(findings, resolveTotalLoc(options));

  const tiers: Record<string, TierResult> = {
    build: evaluateBuildTier(findings),
    security: evaluateSecurityTier(findings, thresholds),
    secrets: evaluateSecretsTier(findings, thresholds),
    coverage: evaluateCoverageTier(health, thresholds),
    duplication: evaluateDuplicationTier(findings, health, thresholds),
    complexity: evaluateRuleTier(findings, "complexity", "complexity", "No complexity issues detected"),
    architecture: evaluateRuleTier(findings, "architecture", "architecture", "No architecture violations detected"),
  };

  let overall = computeOverall(tiers);
  const readinessThreshold = threshold(thresholds, "readiness_threshold");
  if (readiness < readinessThreshold && overall !== "FAIL") overall = readiness >= readinessThreshold * CLOSE_TO_THRESHOLD ? "CONDITIONAL" : "FAIL";

  const counts = countBySeverity(findings);
  const toolsRun = health !== null && "tools_succeeded" in health ? ["tools_succeeded", "tools_skipped", "tools_failed"].reduce((sum, key) => sum + (typeof health[key] === "number" ? health[key] : 0), 0) : 0;
  const summary: QualitySummary = {
    total_findings: findings.length,
    critical: tally(counts, "CRITICAL"),
    high: tally(counts, "HIGH"),
    medium: tally(counts, "MEDIUM"),
    low: tally(counts, "LOW"),
    tools_run: toolsRun,
  };

  let trend: TrendInfo | null = null;
  if (options.auditDir !== undefined) {
    const coverage = health !== null && "coverage_line_pct" in health ? numberFrom(health, "coverage_line_pct") : null;
    appendTrend(options.auditDir, readiness, findings.length, tally(counts, "CRITICAL"), coverage);
    trend = getTrend(options.auditDir);
  }

  const result: QualityGateResult = {
    readiness_score: readiness,
    overall,
    tiers,
    summary,
    trend,
    blocker_explanation: Object.fromEntries(Object.entries(tiers).filter(([, tier]) => tier.status === "FAIL" && tier.blocker_finding_ids.length > 0).map(([name, tier]) => [name, tier.blocker_finding_ids])),
  };
  if (options.auditDir !== undefined) {
    mkdirSync(join(options.auditDir, "data"), { recursive: true });
    writeFileSync(join(options.auditDir, "data", "quality-gate.json"), dumpJson(result) + "\n");
  }
  return result;
}
