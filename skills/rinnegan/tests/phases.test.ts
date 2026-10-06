import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { generatePhaseTasks } from "@rinnegan/create-phase-tasks.ts";
import { generateDagAndConfig, validateNullFixCoverage } from "@rinnegan/run_pipeline_lib.ts";

const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");
const dataFile = (name: string, content: object | string): Record<string, string> => ({ [`data/${name}`]: typeof content === "string" ? content : JSON.stringify(content) });

const SPEC_NODES = [
  { id: 0, name: "Foundation", rules: ["R14"] },
  { id: 1, name: "Security", rules: ["R05"] },
  { id: 2, name: "Typing", rules: ["R07"] },
  { id: 3, name: "SSOT/DRY", rules: ["R01"] },
  { id: 4, name: "Architecture", rules: ["R02", "R03"] },
  { id: 5, name: "Clean Code", rules: ["R09", "R13"] },
  { id: 6, name: "Performance", rules: ["R04"] },
  { id: 7, name: "Data Integrity", rules: ["R12"] },
  { id: 8, name: "Refactoring", rules: ["R10"] },
  { id: 9, name: "Verification", rules: ["R16", "R08"] },
  { id: 10, name: "Documentation", rules: ["R11"] },
];
const SPEC_EDGES = [
  [0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 7], [4, 5], [4, 6], [5, 8], [6, 8], [7, 9], [8, 9], [9, 10],
].map(([from, to]) => ({ from, to }));
const CONFIG_DEFAULTS = {
  commit_strategy: "per-phase",
  session_bridging: "json",
  stale_fix_mode: "adapt",
  mini_scan_after_phase: true,
  full_verify_after_phase: false,
  full_verify_after_all: true,
  max_retries_per_phase: 2,
  max_retries_per_task: 1,
};
const withCounts = (counts: Record<number, number>): object[] => SPEC_NODES.map((node) => ({ ...node, finding_count: counts[node.id] ?? 0 }));

const PROJECT_DIR = "/my/project";

describe("generateDagAndConfig", () => {
  it.each<{ name: string; files: Record<string, string>; counts?: Record<number, number>; stack: string; framework: string }>([
    { name: "an audit without findings: the spec DAG with zero counts and the default config", files: {}, stack: "unknown", framework: "unknown" },
    {
      name: "findings are counted per phase; phases outside 0 to 10 and non-integers are not counted",
      files: dataFile("findings.jsonl", jsonl([{ phase: 0 }, { phase: 0 }, { phase: 1 }, { phase: 5 }, { phase: 10 }, { phase: 11 }, { phase: -1 }, { phase: "3" }, {}])),
      counts: { 0: 2, 1: 1, 5: 1, 10: 1 },
      stack: "unknown",
      framework: "unknown",
    },
    {
      name: "the stack and framework come from the inventory",
      files: dataFile("inventory.json", { stack: "typescript", framework: "next" }),
      stack: "typescript",
      framework: "next",
    },
    {
      name: "config.json outranks the inventory for the stack and framework",
      files: { ...dataFile("inventory.json", { stack: "python", framework: "flask" }), ...dataFile("config.json", { stack: "python", framework: "fastapi" }) },
      stack: "python",
      framework: "fastapi",
    },
  ])("$name", ({ files, counts, stack, framework }) => {
    const audit = projectFiles({ "data/.keep": "", ...files });
    const first = generateDagAndConfig(audit, PROJECT_DIR);
    const second = generateDagAndConfig(audit, PROJECT_DIR);
    expect(second).toEqual(first);
    expect<unknown>(first.dag).toEqual({ nodes: withCounts(counts ?? {}), edges: SPEC_EDGES });
    expect<unknown>(first.config).toEqual({ project_dir: PROJECT_DIR, audit_dir: audit, stack, framework, ...CONFIG_DEFAULTS });
    for (const [file, value] of [["phase-dag.json", first.dag], ["rasengan-config.json", first.config]] as const) {
      const content = readFileSync(join(audit, "data", file), "utf8");
      expect(content).toBe(JSON.stringify(value, null, 2) + "\n");
    }
  });
});

interface FixSpec {
  severity?: string;
  target_code?: string | null;
  fix_plan?: unknown;
}

const candidate = (spec: FixSpec): object => ({ id: "TST-001", rule: "R01", file: "src/foo.ts", line: 10, ...spec });
const many = (count: number, spec: FixSpec): object[] => Array.from({ length: count }, () => candidate(spec));
const PLAN = [{ step: 1, action: "edit", file: "x.ts", description: "fix it" }];

describe("validateNullFixCoverage", () => {
  it.each<{ name: string; findings?: object[]; raw?: string; expected: { triggered: boolean; null_fix_count: number; non_review_count: number; percent: number } }>([
    { name: "every non-REVIEW finding without a fix blocks", findings: many(3, { severity: "HIGH" }), expected: { triggered: true, null_fix_count: 3, non_review_count: 3, percent: 100 } },
    {
      name: "a mixed set blocks on the findings that lack a fix",
      findings: [...many(8, { severity: "HIGH", target_code: "fix()" }), ...many(2, { severity: "HIGH" })],
      expected: { triggered: true, null_fix_count: 2, non_review_count: 10, percent: 20 },
    },
    { name: "target_code on every finding passes", findings: many(20, { severity: "HIGH", target_code: "fixed()" }), expected: { triggered: false, null_fix_count: 0, non_review_count: 20, percent: 0 } },
    { name: "a fix_plan on every finding passes", findings: many(10, { severity: "MEDIUM", fix_plan: PLAN }), expected: { triggered: false, null_fix_count: 0, non_review_count: 10, percent: 0 } },
    {
      name: "one missing fix among twenty still blocks",
      findings: [...many(19, { severity: "HIGH", target_code: "fix()" }), ...many(1, { severity: "HIGH" })],
      expected: { triggered: true, null_fix_count: 1, non_review_count: 20, percent: 5 },
    },
    {
      name: "REVIEW findings without a fix are neither counted nor part of the denominator",
      findings: [...many(10, { severity: "HIGH", target_code: "fix()" }), ...many(50, { severity: "REVIEW" })],
      expected: { triggered: false, null_fix_count: 0, non_review_count: 10, percent: 0 },
    },
    { name: "an empty fix_plan list is no fix", findings: many(1, { severity: "HIGH", fix_plan: [] }), expected: { triggered: true, null_fix_count: 1, non_review_count: 1, percent: 100 } },
    { name: "an empty target_code is no fix", findings: many(1, { severity: "HIGH", target_code: "" }), expected: { triggered: true, null_fix_count: 1, non_review_count: 1, percent: 100 } },
    { name: "a fix_plan that is not a list is no fix", findings: many(1, { severity: "HIGH", fix_plan: "edit it" }), expected: { triggered: true, null_fix_count: 1, non_review_count: 1, percent: 100 } },
    { name: "a finding without a severity counts as non-REVIEW", findings: many(1, {}), expected: { triggered: true, null_fix_count: 1, non_review_count: 1, percent: 100 } },
    { name: "an empty findings file does not block", raw: "", expected: { triggered: false, null_fix_count: 0, non_review_count: 0, percent: 0 } },
    { name: "a missing findings file does not block", expected: { triggered: false, null_fix_count: 0, non_review_count: 0, percent: 0 } },
    { name: "blank lines are skipped", raw: `\n${JSON.stringify(candidate({ severity: "HIGH" }))}\n\n`, expected: { triggered: true, null_fix_count: 1, non_review_count: 1, percent: 100 } },
  ])("$name", ({ findings, raw, expected }) => {
    const content = raw ?? (findings === undefined ? undefined : jsonl(findings));
    const audit = projectFiles(content === undefined ? { "data/.keep": "" } : dataFile("findings.jsonl", content));
    expect(validateNullFixCoverage(audit)).toEqual(expected);
  });
});

interface TaskFile {
  phase: number;
  phase_name: string;
  prerequisites: string[];
  status: string;
  total_tasks: number;
  completed: number;
  tasks: Record<string, unknown>[];
  verification: { command: string; expected: string; description: string };
}

type PhaseReader = (phase: number) => TaskFile;

const readPhase = (audit: string): PhaseReader => (phase) => JSON.parse(readFileSync(join(audit, "data", "tasks", `phase-${phase}-tasks.json`), "utf8")) as TaskFile;

const TASK_KEYS = [
  "id", "status", "rule", "severity", "group", "file", "line", "current_code", "target_code", "imports_needed", "search_pattern",
  "explanation", "effort", "fix_plan", "confidence", "confidence_reason", "completed_at", "resolution", "actual_line", "notes",
];
const PYTHON_BUILD = "uv run python -m compileall -q . >/dev/null 2>&1 && echo PASS";
const PYTHON_VERIFY = `uv run pytest -q >/dev/null 2>&1 && ${PYTHON_BUILD}`;
const MANUAL = { command: "echo MANUAL_REVIEW_REQUIRED", expected: "MANUAL_REVIEW_REQUIRED" };
const GREP_SECURITY = "grep -RInE 'verify=False|shell=True|exec\\(|eval\\(|subprocess\\..*shell=True' . | wc -l | tr -d ' '";
const GREP_HYGIENE =
  "grep -RInE 'console\\.log|TODO|FIXME' . --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.java' --include='*.kt' | wc -l | tr -d ' '";

const inventory = (stack: string): Record<string, string> => ({ "docs/audit/data/inventory.json": JSON.stringify({ stack, framework: "x" }) });
const findingsFile = (rows: object[]): Record<string, string> => ({ "docs/audit/data/findings.jsonl": jsonl(rows) });
const task = (id: string, phase: number | undefined, extra: object = {}): object => ({ id, rule: "R05", severity: "HIGH", file: "app/a.py", line: 1, phase, ...extra });

describe("generatePhaseTasks", () => {
  it.each<{ name: string; files: Record<string, string>; check: (read: PhaseReader, written: string[]) => void }>([
    {
      name: "one file per phase, with imports, prerequisites, fix plans and the security verification",
      files: {
        ...inventory("python"),
        ...findingsFile([
          task("SEC-001", 1, { current_code: "verify=False", target_code: "verify=True", target_import: "from app.http import secure_client", search_pattern: "verify=False", explanation: "TLS validation disabled", effort: "low", fix_plan: null }),
          task("DRY-001", 3, { rule: "R01", severity: "MEDIUM", target_code: null, target_import: null, fix_plan: [{ step: 1, action: "edit", file: "app/constants.py" }] }),
        ]),
      },
      check: (read, written) => {
        expect(written).toHaveLength(11);
        expect(read(1)).toMatchObject({ phase: 1, phase_name: "Security (R05)", prerequisites: ["phase-0"], status: "not_started", total_tasks: 1, completed: 0 });
        expect(read(1).tasks[0]).toMatchObject({ id: "SEC-001", imports_needed: ["from app.http import secure_client"], target_code: "verify=True", status: "pending" });
        expect(read(1).verification).toEqual({ command: GREP_SECURITY, expected: "0", description: "No obvious high-risk security shortcuts remain." });
        expect(read(3).prerequisites).toEqual(["phase-1", "phase-2"]);
        expect(read(3).tasks[0]?.["fix_plan"]).toEqual([{ step: 1, action: "edit", file: "app/constants.py" }]);
        expect(read(4)).toMatchObject({ phase_name: "Architecture (R02, R03)", prerequisites: ["phase-3"] });
        expect(read(10).prerequisites).toEqual(["phase-9"]);
      },
    },
    {
      name: "a task takes only its declared fields, so cap and cluster metadata never reach it",
      files: { ...inventory("python"), ...findingsFile([task("SEC-001", 1, { severity_capped_from: "CRITICAL", cluster_id: "CLU-001", layer: "services", scanner: "grep", snippet: "x" })]) },
      check: (read) => {
        const [first] = read(1).tasks;
        expect(first).not.toHaveProperty("severity_capped_from");
        expect(Object.keys(first ?? {})).toEqual(TASK_KEYS);
        expect(first).toMatchObject({ status: "pending", group: "", current_code: null, target_code: null, fix_plan: null, completed_at: null, resolution: null, actual_line: null, notes: "", effort: "", explanation: "" });
      },
    },
    {
      name: "confidence is lower-cased, defaults to high, and keeps its reason",
      files: {
        ...inventory("python"),
        ...findingsFile([
          task("A-1", 1, { confidence: "LOW", confidence_reason: "LOW: may be intentional (R05-L1)" }),
          task("A-2", 1, { confidence: "low" }),
          task("A-3", 1, {}),
          task("A-4", 1, { confidence: "" }),
        ]),
      },
      check: (read) => expect(read(1).tasks.map((t) => [t["confidence"], t["confidence_reason"]])).toEqual([["low", "LOW: may be intentional (R05-L1)"], ["low", ""], ["high", ""], ["high", ""]]),
    },
    {
      name: "phases without findings are clear, the others not started",
      files: { ...inventory("typescript"), ...findingsFile([task("A-1", 2)]) },
      check: (read) => {
        expect(read(0)).toMatchObject({ status: "clear", total_tasks: 0, tasks: [] });
        expect(read(2)).toMatchObject({ status: "not_started", total_tasks: 1 });
      },
    },
    {
      name: "a finding without a usable phase lands in its rule's phase, else the last phase; tasks are ordered by phase, file, line, id",
      files: {
        ...inventory("python"),
        ...findingsFile([
          task("Z-1", undefined, { rule: "R16", file: "b.py", line: 5 }),
          task("Z-2", undefined, { rule: " R11 ", file: "a.py", line: 9 }),
          task("Z-3", 11, { rule: "R04", file: "a.py", line: 1 }),
          task("Z-4", undefined, { rule: "R99", file: "a.py", line: 2 }),
          task("Z-5", 9, { rule: "R04", file: "b.py", line: 5 }),
          task("Z-0", 9, { rule: "R04", file: "b.py", line: 5 }),
          task("Z-6", 9, { rule: "R04", file: "a.py", line: 7 }),
        ]),
      },
      check: (read) => {
        expect(read(6).tasks.map((t) => t["id"])).toEqual(["Z-3"]);
        expect(read(9).tasks.map((t) => t["id"])).toEqual(["Z-6", "Z-0", "Z-1", "Z-5"]);
        expect(read(10).tasks.map((t) => t["id"])).toEqual(["Z-4", "Z-2"]);
      },
    },
    {
      name: "imports are normalised: lists keep non-blank entries, strings are trimmed, blanks are none",
      files: {
        ...inventory("python"),
        ...findingsFile([
          task("I-1", 1, { target_import: ["import a", "", "   ", "import b"] }),
          task("I-2", 1, { target_import: "  import c  " }),
          task("I-3", 1, { target_import: "  " }),
          task("I-4", 1, { target_import: null }),
        ]),
      },
      check: (read) => expect(read(1).tasks.map((t) => t["imports_needed"])).toEqual([["import a", "import b"], ["import c"], [], []]),
    },
    {
      name: "build verification follows the stack and manual review covers the rest",
      files: { ...inventory("typescript"), ...findingsFile([]) },
      check: (read) => {
        expect(read(0).verification).toEqual({ command: "bunx tsc --noEmit >/dev/null 2>&1 && echo PASS", expected: "PASS", description: "Project builds cleanly before remediation begins." });
        expect(read(3).verification).toEqual({ ...MANUAL, description: "Manual verification required for this architectural phase." });
        expect(read(5).verification).toEqual({ command: GREP_HYGIENE, expected: "0", description: "No obvious hygiene placeholders remain in source files." });
      },
    },
    {
      name: "python builds and verifies through uv",
      files: { ...inventory("python"), ...findingsFile([]), "tests/test_a.py": "" },
      check: (read) => {
        expect(read(0).verification.command).toBe(PYTHON_BUILD);
        expect(read(2).verification.command).toBe("grep -RInE '\\bAny\\b|type:\\s*ignore|typing\\.Any' . --include='*.py' | wc -l | tr -d ' '");
        expect(read(9).verification).toEqual({ command: PYTHON_VERIFY, expected: "PASS", description: "Build and test verification pass for this stack." });
      },
    },
    {
      name: "the final phase verifies the build alone when no tests are detected",
      files: { ...inventory("python"), ...findingsFile([]) },
      check: (read) =>
        expect(read(9).verification).toEqual({ command: PYTHON_BUILD, expected: "PASS", description: "Build verification passes; no stack-level test command was detected." }),
    },
    {
      name: "typescript with a test script verifies tests then types",
      files: { ...inventory("typescript"), ...findingsFile([]), "package.json": JSON.stringify({ scripts: { test: "vitest" } }) },
      check: (read) => expect(read(9).verification.command).toBe("bun run test >/dev/null 2>&1 && bunx tsc --noEmit >/dev/null 2>&1 && echo PASS"),
    },
    {
      name: "java verifies with maven, and an unknown stack needs manual review",
      files: { ...inventory("java"), ...findingsFile([]), "pom.xml": "<project/>" },
      check: (read) => {
        expect(read(0).verification.command).toBe("mvn -q -DskipTests compile >/dev/null 2>&1 && echo PASS");
        expect(read(9).verification.command).toBe("mvn -q test >/dev/null 2>&1 && echo PASS");
      },
    },
    {
      name: "an unknown stack has manual build and typing verification",
      files: { ...inventory("go"), ...findingsFile([]) },
      check: (read) => {
        expect(read(0).verification).toMatchObject(MANUAL);
        expect(read(2).verification).toMatchObject(MANUAL);
        expect(read(9).verification).toMatchObject(MANUAL);
      },
    },
  ])("$name", ({ files, check }) => {
    const project = projectFiles(files);
    const audit = join(project, "docs", "audit");
    const written = generatePhaseTasks(audit, project);
    check(readPhase(audit), written);
    expect(readFileSync(join(audit, "data", "tasks", "phase-0-tasks.json"), "utf8").endsWith("}\n")).toBe(true);
  });
});

const TASKS_CLI = join(import.meta.dir, "..", "scripts", "create-phase-tasks.ts");

describe("create-phase-tasks command line", () => {
  it.each<{ name: string; args: string[]; status: number; stdout: string; finalPhase?: string }>([
    { name: "without an audit directory it prints its usage and fails", args: [], status: 1, stdout: "Usage: create-phase-tasks.ts <audit_dir> [project_dir]\n" },
    {
      name: "the project directory defaults to two levels above the audit directory",
      args: ["docs/audit"],
      status: 0,
      stdout: "Generated 11 phase task files\n",
      finalPhase: "bun run test >/dev/null 2>&1 && bunx tsc --noEmit >/dev/null 2>&1 && echo PASS",
    },
    {
      name: "an explicit project directory decides the stack's test detection",
      args: ["docs/audit", "docs"],
      status: 0,
      stdout: "Generated 11 phase task files\n",
      finalPhase: "bunx tsc --noEmit >/dev/null 2>&1 && echo PASS",
    },
  ])("$name", ({ args, status, stdout, finalPhase }) => {
    const project = projectFiles({ ...inventory("typescript"), ...findingsFile([]), "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const result = Bun.spawnSync([process.execPath, TASKS_CLI, ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect([result.exitCode, result.stdout.toString()]).toEqual([status, stdout]);
    if (finalPhase !== undefined) expect(readPhase(join(project, "docs", "audit"))(9).verification.command).toBe(finalPhase);
  });
});
