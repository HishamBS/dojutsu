import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { evaluateQualityGate } from "@rinnegan/quality_gate.ts";
import { evaluateQualityGateFromAudit } from "@rinnegan/run_pipeline_lib.ts";

const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");
const found = (id: string, rule: string, severity: string): object => ({ id, rule, severity, file: "src/foo.py", line: 10 });
const many = (count: number, rule: string, severity: string, prefix = "T"): object[] =>
  Array.from({ length: count }, (_, i) => found(`${prefix}-${String(i + 1).padStart(3, "0")}`, rule, severity));
const ids = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`);

const GOOD_HEALTH = { coverage_line_pct: 80.0, duplication_pct: 2.0 };
const ALL_PASS_TIERS = {
  build: { status: "PASS", details: "0 type errors, 0 lint errors (0 total build findings)" },
  security: { status: "PASS", details: "0 security vulnerabilities" },
  secrets: { status: "PASS", details: "No secrets or env issues detected" },
  complexity: { status: "PASS", details: "No complexity issues detected" },
  architecture: { status: "PASS", details: "No architecture violations detected" },
};

interface GateCase {
  name: string;
  findings: object[];
  health?: object;
  inventoryLoc?: number;
  options?: { thresholds?: Record<string, number>; totalLoc?: number };
  viaAudit?: boolean;
  expected: object;
}

describe("evaluateQualityGate", () => {
  it.each<GateCase>([
    {
      name: "a high security finding fails security and secrets, names its blocker, and scores 97",
      findings: [found("SEC-001", "R05", "HIGH")],
      options: { totalLoc: 1000 },
      expected: {
        readiness_score: 97,
        overall: "FAIL",
        tiers: {
          security: { status: "FAIL", details: "1 HIGH vulnerabilities (max 0)", blocker_finding_ids: ["SEC-001"] },
          secrets: { status: "FAIL", details: "1 secrets/env issues detected (max 0)", blocker_finding_ids: ["SEC-001"] },
        },
        blocker_explanation: { security: ["SEC-001"], secrets: ["SEC-001"] },
      },
    },
    {
      name: "no findings and no health data: a perfect score, with the data-less tiers warning",
      findings: [],
      options: { totalLoc: 10000 },
      expected: {
        readiness_score: 100,
        overall: "CONDITIONAL",
        tiers: {
          ...ALL_PASS_TIERS,
          coverage: { status: "WARN", details: "No coverage data available" },
          duplication: { status: "WARN", details: "No duplication data available" },
        },
        summary: { total_findings: 0, critical: 0, high: 0, medium: 0, low: 0, tools_run: 0 },
        trend: null,
        blocker_explanation: {},
      },
    },
    {
      name: "healthy coverage and duplication pass every tier, and tools run counts succeeded, skipped and failed",
      findings: [],
      health: { ...GOOD_HEALTH, tools_succeeded: 7, tools_skipped: 1, tools_failed: 1, tools_timed_out: 2 },
      options: { totalLoc: 10000 },
      expected: {
        readiness_score: 100,
        overall: "PASS",
        tiers: { ...ALL_PASS_TIERS, coverage: { status: "PASS", details: "80.0% line coverage (threshold 60%)" }, duplication: { status: "PASS", details: "2.0% duplication (max 5.0%)" } },
        summary: { tools_run: 9 },
      },
    },
    {
      name: "coverage close to the threshold warns and far below it fails",
      findings: [],
      health: { coverage_line_pct: 50.0, duplication_pct: 2.0 },
      options: { totalLoc: 10000 },
      expected: { tiers: { coverage: { status: "WARN", details: "50.0% line coverage (threshold 60%, close)" } }, overall: "CONDITIONAL" },
    },
    {
      name: "low coverage fails",
      findings: [],
      health: { coverage_line_pct: 30.0, duplication_pct: 2.0 },
      options: { totalLoc: 10000 },
      expected: { tiers: { coverage: { status: "FAIL", details: "30.0% line coverage (below 60% threshold)", blocker_finding_ids: [] } }, overall: "FAIL" },
    },
    {
      name: "elevated duplication warns",
      findings: [],
      health: { coverage_line_pct: 80.0, duplication_pct: 6.0 },
      options: { totalLoc: 10000 },
      expected: { tiers: { duplication: { status: "WARN", details: "6.0% duplication (max 5.0%, elevated)" } }, overall: "CONDITIONAL" },
    },
    {
      name: "excess duplication fails and blames the critical and high R01 findings",
      findings: [found("DRY-1", "R01", "HIGH"), found("DRY-2", "R01", "LOW"), found("DRY-3", "R01", "CRITICAL"), found("OTH-1", "R04", "HIGH")],
      health: { coverage_line_pct: 80.0, duplication_pct: 15.0 },
      options: { totalLoc: 100000 },
      expected: { tiers: { duplication: { status: "FAIL", details: "15.0% duplication (exceeds 5.0% threshold)", blocker_finding_ids: ["DRY-1", "DRY-3"] } }, overall: "FAIL" },
    },
    {
      name: "up to five build errors warn and more fail with their ids",
      findings: [...many(3, "R14", "HIGH", "BLD")],
      health: GOOD_HEALTH,
      options: { totalLoc: 100000 },
      expected: { tiers: { build: { status: "WARN", details: "3 build errors (0 critical, 3 high)", blocker_finding_ids: [] } }, overall: "CONDITIONAL" },
    },
    {
      name: "six build errors fail",
      findings: [...many(6, "R14", "CRITICAL", "BLD"), found("BLD-LOW", "R14", "LOW")],
      health: GOOD_HEALTH,
      options: { totalLoc: 100000 },
      expected: { tiers: { build: { status: "FAIL", details: "6 build errors (6 critical, 0 high)", blocker_finding_ids: ids("BLD", 6) } }, overall: "FAIL", blocker_explanation: { build: ids("BLD", 6) } },
    },
    {
      name: "a readiness score under the threshold turns a passing gate conditional",
      findings: many(30, "R04", "MEDIUM", "PERF"),
      health: GOOD_HEALTH,
      options: { totalLoc: 1000 },
      expected: { readiness_score: 70, overall: "CONDITIONAL", tiers: ALL_PASS_TIERS },
    },
    {
      name: "a readiness score below eighty percent of the threshold fails it",
      findings: many(50, "R04", "MEDIUM", "PERF"),
      health: GOOD_HEALTH,
      options: { totalLoc: 1000 },
      expected: { readiness_score: 50, overall: "FAIL", tiers: ALL_PASS_TIERS },
    },
    {
      name: "a score clamped at zero fails, and an unrelated severity cannot hide it",
      findings: many(50, "R14", "CRITICAL", "BLD"),
      health: GOOD_HEALTH,
      options: { totalLoc: 1000 },
      expected: { readiness_score: 0, overall: "FAIL" },
    },
    {
      name: "threshold overrides move the verdicts",
      findings: [found("SEC-001", "R05", "CRITICAL")],
      health: GOOD_HEALTH,
      options: { totalLoc: 100000, thresholds: { max_critical_vulns: 1, max_secrets: 1 } },
      expected: {
        tiers: {
          security: { status: "WARN", details: "1 critical, 0 high vulnerabilities (within thresholds)" },
          secrets: { status: "WARN", details: "1 env-related findings (no critical secrets)" },
        },
        overall: "CONDITIONAL",
      },
    },
    {
      name: "complexity and architecture tiers read their own rules",
      findings: [found("CX-1", "R02", "CRITICAL"), found("AR-1", "R03", "HIGH"), found("AR-2", "R10", "MEDIUM"), found("CL-1", "R09", "LOW")],
      health: GOOD_HEALTH,
      options: { totalLoc: 100000 },
      expected: {
        tiers: {
          complexity: { status: "FAIL", details: "1 high-severity complexity issues out of 2 total", blocker_finding_ids: ["CX-1"] },
          architecture: { status: "FAIL", details: "2 high-severity architecture violations out of 3 total", blocker_finding_ids: ["CX-1", "AR-1"] },
        },
      },
    },
    {
      name: "non-critical findings in a tier only warn",
      findings: [found("CL-1", "R09", "LOW"), found("AR-1", "R10", "MEDIUM")],
      health: GOOD_HEALTH,
      options: { totalLoc: 100000 },
      expected: {
        tiers: {
          complexity: { status: "WARN", details: "1 complexity findings (none critical/high)" },
          architecture: { status: "WARN", details: "1 architecture findings (none critical/high)" },
        },
      },
    },
    {
      name: "severity counts and the score weigh every severity, a REVIEW finding as medium",
      findings: [...many(2, "R04", "CRITICAL"), found("H", "R04", "HIGH"), ...many(2, "R04", "MEDIUM"), found("L", "R04", "LOW"), found("RV", "R04", "REVIEW")],
      health: GOOD_HEALTH,
      options: { totalLoc: 5000 },
      expected: { readiness_score: 94.76, summary: { total_findings: 7, critical: 2, high: 1, medium: 2, low: 1 } },
    },
    {
      name: "the mixed weighting of the original contract",
      findings: [found("A", "R04", "CRITICAL"), ...many(2, "R04", "HIGH"), ...many(3, "R04", "MEDIUM"), found("L", "R04", "LOW")],
      health: GOOD_HEALTH,
      options: { totalLoc: 5000 },
      expected: { readiness_score: 96.16 },
    },
    {
      name: "lines of code come from the inventory when none are given, with a one KLOC floor",
      findings: many(5, "R04", "CRITICAL"),
      health: GOOD_HEALTH,
      inventoryLoc: 5000,
      expected: { readiness_score: 90 },
    },
    {
      name: "the audit wrapper reads the findings, health and inventory from the audit directory and passes thresholds on",
      findings: [found("SEC-001", "R05", "CRITICAL")],
      health: GOOD_HEALTH,
      inventoryLoc: 100000,
      options: { thresholds: { max_critical_vulns: 1, max_secrets: 1 } },
      viaAudit: true,
      expected: { readiness_score: 99.9, overall: "CONDITIONAL", tiers: { security: { status: "WARN" }, coverage: { status: "PASS", details: "80.0% line coverage (threshold 60%)" } } },
    },
    { name: "no lines of code at all scores against one KLOC", findings: [found("M", "R04", "MEDIUM")], health: GOOD_HEALTH, expected: { readiness_score: 99 } },
  ])("$name", ({ findings, health, inventoryLoc, options, viaAudit, expected }) => {
    const audit = projectFiles({
      "data/findings.jsonl": jsonl(findings),
      ...(health === undefined ? {} : { "data/pipeline-health.json": JSON.stringify(health) }),
      ...(inventoryLoc === undefined ? {} : { "data/inventory.json": JSON.stringify({ total_loc: inventoryLoc, files: [], layers: {} }) }),
    });
    const result =
      viaAudit === true
        ? evaluateQualityGateFromAudit(audit, options?.thresholds)
        : evaluateQualityGate(join(audit, "data", "findings.jsonl"), {
            ...(health === undefined ? {} : { healthPath: join(audit, "data", "pipeline-health.json") }),
            auditDir: audit,
            ...options,
          });
    expect<Record<string, unknown>>(result).toMatchObject(expected);
    expect(JSON.parse(readFileSync(join(audit, "data", "quality-gate.json"), "utf8"))).toEqual(result);
  });
});
