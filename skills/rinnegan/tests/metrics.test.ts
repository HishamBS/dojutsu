import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { computeStats, writeStats } from "@rinnegan/compute_audit_stats.ts";
import { writeHealthReport } from "@rinnegan/pipeline_health.ts";
import { appendTrend, getTrend } from "@rinnegan/readiness_trend.ts";
import type { ToolResult } from "@rinnegan/tool_runner.ts";

interface FindingSpec {
  id: string;
  rule: string;
  severity: string;
  category: string;
  file: string;
  phase: number | string;
  scanner: string;
  layer: string;
  cross_cutting?: boolean;
  cross_cutting_group?: string;
  current_code?: string;
  fix_plan?: string;
}

const finding = (spec: FindingSpec): Record<string, unknown> => ({
  line: 10, snippet: "x = 1", description: "Test finding", explanation: "test", search_pattern: "x = 1", effort: "low",
  current_code: "x: any = 1", fix_plan: "", cross_cutting: false, cross_cutting_group: "", ...spec,
});

const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");
const dataFile = (name: string, content: object | string): Record<string, string> => ({ [`data/${name}`]: typeof content === "string" ? content : JSON.stringify(content) });

const MINIMAL_FINDINGS = [
  finding({ id: "F001", rule: "R07", severity: "CRITICAL", category: "typing", file: "src/a.py", phase: 2, scanner: "grep-scanner", layer: "services" }),
  finding({ id: "F002", rule: "R01", severity: "HIGH", category: "ssot-dry", file: "src/b.py", phase: 3, scanner: "jscpd", layer: "services", cross_cutting: true, cross_cutting_group: "R01 across 3 files" }),
  finding({ id: "F003", rule: "R01", severity: "MEDIUM", category: "ssot-dry", file: "src/c.py", phase: 3, scanner: "jscpd", layer: "utils", cross_cutting: true, cross_cutting_group: "R01 across 3 files" }),
  finding({ id: "F004", rule: "R05", severity: "LOW", category: "security", file: "src/d.py", phase: 1, scanner: "semgrep", layer: "controllers", current_code: "" }),
  finding({ id: "F005", rule: "R09", severity: "REVIEW", category: "clean-code", file: "src/a.py", phase: 5, scanner: "grep-scanner", layer: "services", fix_plan: "Remove dead code" }),
];
const MINIMAL_INVENTORY = {
  root: "backend", stack: "python", framework: "fastapi", total_files: 50, total_loc: 5000,
  layers: { services: { files: ["src/a.py", "src/b.py"], loc: 2000 }, utils: { files: ["src/c.py"], loc: 500 }, controllers: { files: ["src/d.py"], loc: 800 } },
};
const MINIMAL_HEALTH = {
  timestamp: "2026-04-13T12:00:00+00:00", tools_available: 4, tools_succeeded: 3, tools_failed: 1, total_deterministic_findings: 10,
  tool_results: [
    { tool: "grep-scanner", status: "success", findings: 5, duration_ms: 100 },
    { tool: "jscpd", status: "success", findings: 3, duration_ms: 200 },
    { tool: "semgrep", status: "success", findings: 2, duration_ms: 300 },
    { tool: "gitleaks", status: "failed", findings: 0, duration_ms: 50 },
  ],
};
const MINIMAL_GATE = {
  readiness_score: 85.0, overall: "CONDITIONAL", tiers: { build: { status: "PASS", details: "0 errors" } },
  summary: { total_findings: 5, critical: 1, high: 1, medium: 1, low: 1 },
};

const SEVERITIES = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, REVIEW: 0 };

interface StatsCase {
  name: string;
  files: Record<string, string>;
  expected: Record<string, unknown>;
  exact?: boolean;
}

describe("computeStats", () => {
  it.each<StatsCase>([
    {
      name: "a complete audit directory: every breakdown, count and ordering",
      files: {
        ...dataFile("findings.jsonl", jsonl(MINIMAL_FINDINGS)),
        ...dataFile("inventory.json", MINIMAL_INVENTORY),
        ...dataFile("pipeline-health.json", MINIMAL_HEALTH),
        ...dataFile("quality-gate.json", MINIMAL_GATE),
      },
      exact: true,
      expected: {
        project_name: "backend", stack: "python", framework: "fastapi", total_files: 50, total_loc: 5000,
        total_findings: 5, total_raw_findings: 5, dedup_count: 0, affected_files: 4,
        severity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1, REVIEW: 1 },
        categories: [
          { name: "ssot-dry", count: 2, critical: 0, high: 1, medium: 1, low: 0, review: 0 },
          { name: "typing", count: 1, critical: 1, high: 0, medium: 0, low: 0, review: 0 },
          { name: "security", count: 1, critical: 0, high: 0, medium: 0, low: 1, review: 0 },
          { name: "clean-code", count: 1, critical: 0, high: 0, medium: 0, low: 0, review: 1 },
        ],
        layers: [
          { name: "services", files: 2, loc: 2000, findings: 3, density_per_kloc: 1.5 },
          { name: "utils", files: 1, loc: 500, findings: 1, density_per_kloc: 2.0 },
          { name: "controllers", files: 1, loc: 800, findings: 1, density_per_kloc: 1.2 },
        ],
        phases: [
          { phase: 1, name: "Security", findings: 1, critical: 0, high: 0 },
          { phase: 2, name: "Typing Discipline", findings: 1, critical: 1, high: 0 },
          { phase: 3, name: "SSOT / DRY", findings: 2, critical: 0, high: 1 },
          { phase: 5, name: "Clean Code", findings: 1, critical: 0, high: 0 },
        ],
        hotspots: [{ file: "src/a.py", findings: 2 }, { file: "src/b.py", findings: 1 }, { file: "src/c.py", findings: 1 }, { file: "src/d.py", findings: 1 }],
        cross_cutting: { total_findings_in_groups: 2, total_groups: 1, percent_cross_cutting: 40.0 },
        quality_gate: MINIMAL_GATE,
        pipeline_health: MINIMAL_HEALTH,
        enrichment: { has_target_code: 4, has_fix_plan: 1, has_either: 4, has_neither: 1, enrichment_rate_percent: 80.0 },
        scanners: [{ name: "grep-scanner", count: 2 }, { name: "jscpd", count: 2 }, { name: "semgrep", count: 1 }],
        rules: [
          { rule: "R01", count: 2, name: "SSOT & DRY" },
          { rule: "R07", count: 1, name: "Strict Typing" },
          { rule: "R05", count: 1, name: "Security" },
          { rule: "R09", count: 1, name: "Clean Code" },
        ],
        clusters: { total_clusters: 0, ids: [] },
        families: { families_created: 0, root_causes: 0, subordinate_findings: 0 },
      },
    },
    {
      name: "an empty audit directory reports zeros and unknowns, not a clean project",
      files: {},
      expected: {
        project_name: "unknown", stack: "unknown", framework: "unknown", total_files: 0, total_loc: 0, total_findings: 0, affected_files: 0,
        severity: SEVERITIES, categories: [], layers: [], phases: [], hotspots: [], quality_gate: {}, pipeline_health: {},
        enrichment: { has_target_code: 0, has_fix_plan: 0, has_either: 0, has_neither: 0, enrichment_rate_percent: 0.0 },
        cross_cutting: { total_findings_in_groups: 0, total_groups: 0, percent_cross_cutting: 0.0 },
      },
    },
    {
      name: "an unknown severity counts toward the total only, and missing fields take their defaults",
      files: dataFile("findings.jsonl", jsonl([{ severity: "INFO", file: "a.ts" }, {}])),
      expected: {
        total_findings: 2, affected_files: 1,
        severity: { ...SEVERITIES, MEDIUM: 1 },
        categories: [{ name: "uncategorized", count: 2, critical: 0, high: 0, medium: 1, low: 0, review: 0 }],
        layers: [{ name: "unknown", files: 0, loc: 0, findings: 2, density_per_kloc: 0.0 }],
        hotspots: [{ file: "a.ts", findings: 1 }, { file: "unknown", findings: 1 }],
        scanners: [{ name: "unknown", count: 2 }],
        rules: [{ rule: "UNKNOWN", count: 2, name: "UNKNOWN" }],
        phases: [{ phase: 0, name: "Foundation / Build", findings: 2, critical: 0, high: 0 }],
      },
    },
    {
      name: "phases are numeric: strings parse, garbage is phase 0, an unnamed phase gets its number, order is numeric",
      files: dataFile(
        "findings.jsonl",
        jsonl([{ phase: "3" }, { phase: "abc" }, { phase: 12 }, { phase: 3 }, { phase: 12, severity: "CRITICAL" }]),
      ),
      expected: {
        phases: [
          { phase: 0, name: "Foundation / Build", findings: 1, critical: 0, high: 0 },
          { phase: 3, name: "SSOT / DRY", findings: 2, critical: 0, high: 0 },
          { phase: 12, name: "Phase 12", findings: 2, critical: 1, high: 0 },
        ],
      },
    },
    {
      name: "config supplies the stack and framework but never the totals",
      files: {
        ...dataFile("findings.jsonl", jsonl(MINIMAL_FINDINGS)),
        ...dataFile("inventory.json", MINIMAL_INVENTORY),
        ...dataFile("config.json", { stack: "typescript", framework: "react", total_findings: 60, deduped_count: 5 }),
      },
      expected: { stack: "typescript", framework: "react", total_findings: 5, total_raw_findings: 5, dedup_count: 0 },
    },
    {
      name: "a layer with no LOC or absent from the inventory has zero density",
      files: {
        ...dataFile("findings.jsonl", jsonl([finding({ id: "F1", rule: "R07", severity: "LOW", category: "typing", file: "a.py", phase: 2, scanner: "s", layer: "empty_layer" })])),
        ...dataFile("inventory.json", { root: "t", total_files: 1, total_loc: 100, layers: { empty_layer: { files: [], loc: 0 } } }),
      },
      expected: { layers: [{ name: "empty_layer", files: 0, loc: 0, findings: 1, density_per_kloc: 0.0 }] },
    },
    {
      name: "cluster and family rollups come from their data files",
      files: {
        "deep/clusters.json": JSON.stringify({ clusters: [{ id: "CLU-001" }, { id: "" }, { id: "CLU-002" }] }),
        ...dataFile("finding-families.json", { summary: { families_created: 2, root_causes: 2, subordinate_findings: 5 } }),
      },
      expected: { clusters: { total_clusters: 3, ids: ["CLU-001", "CLU-002"] }, families: { families_created: 2, root_causes: 2, subordinate_findings: 5 } },
    },
    {
      name: "enrichment counts a target or a non-empty fix plan, not an empty list",
      files: dataFile(
        "findings.jsonl",
        jsonl([
          { current_code: "", target_code: "fixed()" },
          { current_code: "", fix_plan: [] },
          { current_code: "", fix_plan: [{ step: 1 }] },
          { current_code: "x" },
        ]),
      ),
      expected: { enrichment: { has_target_code: 2, has_fix_plan: 1, has_either: 3, has_neither: 1, enrichment_rate_percent: 75.0 } },
    },
  ])("$name", ({ files, expected, exact }) => {
    const audit = projectFiles(files);
    const { generated_at: generatedAt, audit_date: auditDate, ...stats } = computeStats(audit);
    if (exact === true) expect<Record<string, unknown>>(stats).toEqual(expected);
    else expect<Record<string, unknown>>(stats).toMatchObject(expected);
    expect(generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00$/);
    const today = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    expect(auditDate).toBe(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  });
});

const STATS_CLI = join(import.meta.dir, "..", "scripts", "compute_audit_stats.ts");

describe("writeStats and its command line", () => {
  it.each<{ name: string; viaCli: boolean; withArgument: boolean; status: number; stdout: (audit: string) => string; written: boolean }>([
    { name: "the API writes data/audit-stats.json and returns its path", viaCli: false, withArgument: true, status: 0, stdout: () => "", written: true },
    {
      name: "the command prints where it wrote the stats",
      viaCli: true,
      withArgument: true,
      status: 0,
      stdout: (audit) => `Stats written to ${join(audit, "data", "audit-stats.json")}\n`,
      written: true,
    },
    { name: "the command without an audit directory prints its usage and fails", viaCli: true, withArgument: false, status: 1, stdout: () => "Usage: compute_audit_stats.ts <audit_dir>\n", written: false },
  ])("$name", ({ viaCli, withArgument, status, stdout, written }) => {
    const audit = projectFiles({ "findings-source/keep.txt": "", ...dataFile("findings.jsonl", jsonl([{ file: "src/\u00e9.ts", severity: "HIGH" }])) });
    const target = join(audit, "data", "audit-stats.json");
    if (viaCli) {
      const result = Bun.spawnSync([process.execPath, STATS_CLI, ...(withArgument ? [audit] : [])], { stdout: "pipe", stderr: "pipe" });
      expect([result.exitCode, result.stdout.toString()]).toEqual([status, stdout(audit)]);
    } else {
      expect(writeStats(audit)).toBe(target);
    }
    expect(existsSync(target)).toBe(written);
    if (!written) return;
    const content = readFileSync(target, "utf8");
    expect(content.startsWith('{\n  "generated_at": "')).toBe(true);
    expect(content.endsWith("}\n")).toBe(true);
    expect(content).toContain('"file": "src/\\u00e9.ts"');
    expect(JSON.parse(content)).toMatchObject({ total_findings: 1, severity: { HIGH: 1 } });
  });
});

const tool = (name: string, status: ToolResult["status"], findingCount: number, durationMs: number, error = ""): ToolResult => ({
  tool: name, status, findings: [], durationMs, error, findingCount,
});

describe("writeHealthReport", () => {
  it.each<{ name: string; results: ToolResult[]; files?: Record<string, string>; expected: Record<string, unknown> }>([
    {
      name: "counts every status apart and lists each tool, with an error only when there is one",
      results: [tool("eslint", "success", 10, 500), tool("tsc", "failed", 0, 200, "parse error"), tool("semgrep", "timeout", 0, 300000, "Tool timed out after 300s"), tool("coverage", "skipped", 0, 1, "no runner")],
      expected: {
        tools_available: 4, tools_succeeded: 1, tools_skipped: 1, tools_failed: 1, tools_timed_out: 1, total_deterministic_findings: 10,
        total_files: 0, total_loc: 0,
        tool_results: [
          { tool: "eslint", status: "success", findings: 10, duration_ms: 500 },
          { tool: "tsc", status: "failed", findings: 0, duration_ms: 200, error: "parse error" },
          { tool: "semgrep", status: "timeout", findings: 0, duration_ms: 300000, error: "Tool timed out after 300s" },
          { tool: "coverage", status: "skipped", findings: 0, duration_ms: 1, error: "no runner" },
        ],
      },
    },
    {
      name: "project size comes from the inventory",
      results: [tool("eslint", "success", 1, 50)],
      files: dataFile("inventory.json", { files: [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }], total_loc: 5000 }),
      expected: { total_files: 3, total_loc: 5000, tools_available: 1, total_deterministic_findings: 1 },
    },
    {
      name: "an unparsable inventory leaves the size at zero",
      results: [tool("ruff", "success", 0, 10)],
      files: dataFile("inventory.json", "{not json"),
      expected: { total_files: 0, total_loc: 0 },
    },
    {
      name: "no tools is a report of zeros",
      results: [],
      expected: { tools_available: 0, tools_succeeded: 0, tools_skipped: 0, tools_failed: 0, tools_timed_out: 0, total_deterministic_findings: 0, tool_results: [] },
    },
  ])("$name", ({ results, files, expected }) => {
    const audit = projectFiles(files ?? { "keep.txt": "" });
    const report = writeHealthReport(audit, results);
    const { timestamp, ...rest } = report;
    expect(timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00$/);
    expect<Record<string, unknown>>(rest).toMatchObject(expected);
    const content = readFileSync(join(audit, "data", "pipeline-health.json"), "utf8");
    expect(content.startsWith('{\n  "timestamp": "')).toBe(true);
    expect(content.endsWith("\n")).toBe(false);
    expect(JSON.parse(content)).toEqual(report);
  });
});

type HistoryEntry = [score: number, findings: number, critical: number, coverage?: number];

describe("readiness trend", () => {
  it.each<{ name: string; history?: string; appends?: HistoryEntry[]; trend: object | null; lastEntry?: object }>([
    { name: "no history file has no trend", trend: null },
    { name: "one entry is not yet a trend", appends: [[80.0, 50, 2]], trend: null },
    { name: "a rising score improves", appends: [[75.0, 80, 5], [84.0, 50, 2]], trend: { current: 84, previous: 75, delta: 9, direction: "improving" } },
    { name: "a falling score declines", appends: [[90.0, 30, 0], [85.0, 40, 1]], trend: { current: 85, previous: 90, delta: -5, direction: "declining" } },
    { name: "an unchanged score is stable", appends: [[70.0, 30, 0], [70.0, 31, 0]], trend: { current: 70, previous: 70, delta: 0, direction: "stable" } },
    {
      name: "scores and coverage are stored to two decimals and the delta is rounded the same way",
      appends: [[75.1, 80, 5, 60.456], [84.456, 50, 2, 71.234]],
      trend: { current: 84.46, previous: 75.1, delta: 9.36, direction: "improving" },
      lastEntry: { score: 84.46, findings: 50, critical: 2, coverage: 71.23 },
    },
    { name: "an entry appended without coverage records null", appends: [[80.0, 50, 2]], trend: null, lastEntry: { score: 80, findings: 50, critical: 2, coverage: null } },
    {
      name: "corrupted lines, blank lines and entries without a score are skipped",
      history: ['{"score": 60.0, "findings": 9}', "not json {{", "", '{"findings": 3}', '{"score": 66.5}', '[1, 2]', '{"score": "high"}'].join("\n") + "\n",
      trend: { current: 66.5, previous: 60, delta: 6.5, direction: "improving" },
    },
  ])("$name", ({ history, appends, trend, lastEntry }) => {
    const audit = projectFiles(history === undefined ? { "keep.txt": "" } : dataFile("readiness-history.jsonl", history));
    for (const [score, findings, critical, coverage] of appends ?? []) appendTrend(audit, score, findings, critical, coverage);
    expect<unknown>(getTrend(audit)).toEqual(trend);
    if (lastEntry === undefined) return;
    const lines = readFileSync(join(audit, "data", "readiness-history.jsonl"), "utf8").trimEnd().split("\n");
    const entry: unknown = JSON.parse(lines[lines.length - 1] ?? "");
    expect(entry).toMatchObject(lastEntry);
    expect(entry).toHaveProperty("timestamp");
  });
});
