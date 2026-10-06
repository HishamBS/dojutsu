import { describe, expect, it } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { withToolEnvironment } from "@quality-test/fake-tools.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { runPipeline } from "@rinnegan/run-pipeline.ts";

type Row = Record<string, unknown>;

const DATA = "docs/audit/data";
const SCANNER_OUTPUT = `${DATA}/scanner-output`;
const HUSKY = { ".husky/pre-commit": "#!/bin/sh\n" };

const json = (value: unknown): string => JSON.stringify(value);
const jsonl = (rows: Row[]): string => rows.map((row) => json(row) + "\n").join("");

const inventory = (): string =>
  json({
    root: "proj",
    stack: "typescript",
    framework: "none",
    total_files: 1,
    total_loc: 10,
    layers: { app: { files: ["src/index.ts"], loc: 10 } },
    files: [{ path: "src/index.ts", loc: 10, layer: "app", tag: "SOURCE", nominal: false, is_meta_file: false }],
  });

const batch = (overrides: Row = {}): Row => ({
  id: 1,
  layer: "app",
  files: ["src/index.ts"],
  status: "pending",
  output_file: "data/scanner-output/scanner-1-app.jsonl",
  finding_count: 0,
  ...overrides,
});

const plan = (batches: Row[]): string => json({ total_batches: batches.length, completed: batches.filter((b) => b["status"] === "complete").length, batches });

const scannerRow = (overrides: Row = {}): Row => ({
  rule: "R09",
  severity: "LOW",
  category: "clean-code",
  file: "src/index.ts",
  line: 1,
  description: "console.log left in production code",
  search_pattern: "console.log",
  phase: 5,
  scanner: "scanner-1-app",
  ...overrides,
});

// A project that has the quality gates, an inventory and a plan with the given batches.
const planned = (batches: Row[], extra: Record<string, string> = {}): Record<string, string> => ({
  ...HUSKY,
  [`${DATA}/inventory.json`]: inventory(),
  [`${DATA}/scan-plan.json`]: plan(batches),
  ...extra,
});

const completeScannerOutput = (rows: Row[]): Record<string, string> => ({
  [`${SCANNER_OUTPUT}/scanner-1-app.jsonl`]: jsonl(rows),
  [`${SCANNER_OUTPUT}/scanner-1-app.jsonl.done`]: json({ lines: rows.length }),
});

const aggregatedFinding = (overrides: Row = {}): Row => ({
  id: "CLN-001",
  rule: "R09",
  category: "clean-code",
  severity: "LOW",
  file: "src/index.ts",
  line: 1,
  description: "console.log left in production code",
  layer: "app",
  ...overrides,
});

const withAggregatedFindings = (rows: Row[]): Record<string, string> =>
  planned([batch({ status: "complete" })], {
    ...completeScannerOutput([scannerRow()]),
    [`${DATA}/findings.jsonl`]: jsonl(rows),
    [`${DATA}/findings.jsonl.done`]: json({ lines: rows.length }),
  });

async function run(project: string, auditOnly = false): Promise<string> {
  let text = "";
  const code = await runPipeline(project, { auditOnly, out: (chunk) => (text += chunk) });
  expect(code).toBe(0);
  return text;
}

interface StateCase {
  name: string;
  files: Record<string, string>;
  contains: string[];
  omits?: string[];
}

describe("runPipeline state and next action", () => {
  it.each<StateCase>([
    {
      name: "a project without quality gates is sent to setup",
      files: { "src/index.ts": "export const value = 1;\n" },
      contains: ["STATE: NEEDS_QUALITY_GATES", "ACTION: Run /setup-quality-gates on this project first."],
      omits: ["AUDIT_DIR:"],
    },
    {
      name: "a pending scan batch dispatches a scanner with the sonnet directive",
      files: planned([batch()]),
      contains: ["STATE: NEEDS_SCANNING", 'ENFORCE: pass model: "sonnet"', "SCAN_PROGRESS: 0/1 complete, 1 pending, 0 failed", "SCANNER_BATCH: id=1 layer=app"],
    },
    {
      name: "a batch over its retry budget is failed and not dispatched again",
      files: planned([batch({ retries: 2 })]),
      contains: ["CIRCUIT BREAKER: 1 batches exceeded 2 retries", "All remaining batches resolved (0 complete, 1 failed). Re-run to advance pipeline."],
      omits: ["SCANNER_BATCH:"],
    },
    {
      name: "a scanner that left files unread queues them as a follow-up batch",
      files: planned([batch({ files: ["src/a.ts", "src/b.ts", "src/c.ts"] })], {
        [`${SCANNER_OUTPUT}/scanner-1-app.jsonl`]: jsonl([{ rule: "R09", file: "src/a.ts", line: 1, description: "x" }]),
        [`${SCANNER_OUTPUT}/scanner-1-app.jsonl.done`]: json({ lines: 1, files_scanned: 1, unscanned_files: ["src/b.ts", "src/c.ts"] }),
      }),
      contains: ["SCAN_PARTIAL: batch 1 left 2 of 3 files unscanned; queued batch 2 for: src/b.ts src/c.ts", "SCANNER_BATCH: id=2 layer=app"],
    },
    {
      name: "findings in the default mode are sent to enrichment with the sonnet directive",
      files: withAggregatedFindings([aggregatedFinding({ target_code: "x", fix_plan: [] })]),
      contains: ["STATE: NEEDS_ENRICHMENT", 'ENFORCE: pass model: "sonnet"', "LAYER: app (1 findings)"],
    },
    {
      name: "enriched layers that still hold findings without a fix block phase generation",
      files: {
        ...withAggregatedFindings([aggregatedFinding()]),
        [`${DATA}/enriched/app.jsonl`]: jsonl([aggregatedFinding()]),
        [`${DATA}/enriched/app.jsonl.done`]: json({ lines: 1 }),
      },
      contains: ["STATE: BLOCKED_NULL_FIX", "BLOCKED: 1/1 non-REVIEW findings (100.0%) have BOTH target_code and fix_plan null."],
    },
  ])("$name", async ({ files, contains, omits = [] }) => {
    const output = await run(projectFiles(files));

    for (const text of contains) expect(output).toContain(text);
    for (const text of omits) expect(output).not.toContain(text);
  });
});

describe("runPipeline --audit-only", () => {
  it("skips enrichment, and the choice persists when the pipeline is entered again without the flag", async () => {
    const project = projectFiles(withAggregatedFindings([aggregatedFinding()]));

    const first = await run(project, true);
    const again = await run(project);

    expect(first).not.toContain("NEEDS_ENRICHMENT");
    expect(again).not.toContain("NEEDS_ENRICHMENT");
    expect(existsSync(join(project, DATA, ".audit-only"))).toBe(true);
  });
});

function readRows(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Row => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError(`not an object row: ${line}`);
      return parsed;
    });
}

const readRecord = (path: string): Row => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new TypeError(`not an object: ${path}`);
  return parsed;
};

describe("runPipeline aggregation", () => {
  it.each([
    { name: "one scanner", files: ["scanner-1-app.jsonl"] },
    { name: "three scanners reporting the same violation", files: ["grep-scanner.jsonl", "tool-scanner.jsonl", "scanner-1-app.jsonl"] },
  ])("aggregates $name in code and the next run moves on to enrichment", async ({ files }) => {
    const outputs: Record<string, string> = {};
    for (const name of files) outputs[`${SCANNER_OUTPUT}/${name}`] = jsonl([scannerRow({ scanner: name.replace(".jsonl", "") })]);
    const project = projectFiles({ ...planned([batch({ status: "complete" })]), ...outputs, [`${SCANNER_OUTPUT}/scanner-1-app.jsonl.done`]: json({ lines: 1 }) });

    const first = await run(project);
    const second = await run(project);

    expect(readRows(join(project, DATA, "findings.jsonl")).map((row) => [row["id"], row["layer"]])).toEqual([["CLN-001", "app"]]);
    expect(readRecord(join(project, DATA, "findings.jsonl.done"))["lines"]).toBe(1);
    expect(readRecord(join(project, DATA, "config.json"))).toEqual({ stack: "typescript", framework: "none", project: "proj" });
    expect(first).not.toContain("aggregator-prompt.md");
    expect(second).toContain("STATE: NEEDS_ENRICHMENT");
  });
});

const MERGE_CLI = join(import.meta.dir, "..", "scripts", "merge-enriched.ts");
const MAX_RUNS = 12;

// Plays the agents: answers each action the pipeline emits with the output the agent would
// write, and runs the merge command the enrichment action names.
function answerAgents(project: string, output: string): void {
  const auditDir = join(project, "docs", "audit");
  if (output.includes("STATE: NEEDS_SCANNING")) {
    for (const match of output.matchAll(/SCANNER_BATCH: id=\d+ layer=\S+ output=(\S+) files=\d+/g)) {
      const path = match[1] ?? "";
      writeFileSync(path, jsonl([scannerRow()]));
      writeFileSync(`${path}.done`, json({ lines: 1 }));
    }
  }
  if (output.includes("STATE: NEEDS_ENRICHMENT")) {
    const findings = readRows(join(auditDir, "data", "findings.jsonl"));
    mkdirSync(join(auditDir, "data", "enriched"), { recursive: true });
    for (const layer of new Set(findings.map((row) => String(row["layer"])))) {
      const rows = findings.filter((row) => row["layer"] === layer).map((row) => ({ ...row, target_code: "removed", fix_plan: [] }));
      writeFileSync(join(auditDir, "data", "enriched", `${layer}.jsonl`), jsonl(rows));
      writeFileSync(join(auditDir, "data", "enriched", `${layer}.jsonl.done`), json({ lines: rows.length }));
    }
    const merged = Bun.spawnSync([process.execPath, MERGE_CLI, auditDir], { stdout: "pipe", stderr: "pipe" });
    expect(merged.exitCode).toBe(0);
  }
}

const TWELVE_LINE_SOURCE = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";

describe("runPipeline end to end", () => {
  it.each([
    { name: "with enrichment", auditOnly: false },
    { name: "audit-only, with no enrichment", auditOnly: true },
  ])("repeated runs on a real project $name reach PIPELINE_COMPLETE", async ({ auditOnly }) => {
    const project = projectFiles({ ...HUSKY, "src/index.ts": TWELVE_LINE_SOURCE });

    const first = await run(project, auditOnly);
    let output = first;
    for (let runs = 0; runs < MAX_RUNS && !output.includes("PIPELINE_COMPLETE"); runs += 1) {
      answerAgents(project, output);
      output = await run(project, auditOnly);
    }

    expect(first).toContain("STATE: NEEDS_SCANNING");
    expect(output).toContain("PIPELINE_COMPLETE");
    expect(output).toContain("Publication contract: valid");
  });
});

const PIPELINE_CLI = join(import.meta.dir, "..", "scripts", "run-pipeline.ts");
const EXECUTABLE_MODE = 0o755;
const FAILING_BUN_STATUS = 97;

describe("run-pipeline command line", () => {
  it("runs its deterministic steps on the running Bun, never on a bun found on PATH", () => {
    const scratch = mkdtempSync(join(tmpdir(), "quality-skills-bin-"));
    try {
      writeFileSync(join(scratch, "bun"), `#!/bin/sh\nexit ${FAILING_BUN_STATUS}\n`);
      chmodSync(join(scratch, "bun"), EXECUTABLE_MODE);
      const project = projectFiles({ ...HUSKY, "src/index.ts": TWELVE_LINE_SOURCE });
      const env = { ...process.env, PATH: `${scratch}:/usr/bin:/bin` };

      const result = Bun.spawnSync([process.execPath, PIPELINE_CLI, project], { env, stdout: "pipe", stderr: "pipe" });

      expect(result.stdout.toString()).toContain("STATE: NEEDS_SCANNING");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

const KNOWN_BAD_PROJECT = join(import.meta.dir, "fixtures", "known_bad_project");
const CANONICAL_CATEGORIES = ["security", "typing", "ssot-dry", "architecture", "clean-code", "performance", "data-integrity", "refactoring", "full-stack", "documentation", "build"];

describe("runPipeline on the known-bad fixture project", () => {
  it("inventories it, finds the planted violations and files them under canonical categories", async () => {
    const project = projectFiles(HUSKY);
    cpSync(KNOWN_BAD_PROJECT, project, { recursive: true });
    // The Python source is stored as config.py.txt so no checker takes the fixture for first-party Python.
    renameSync(join(project, "app", "config.py.txt"), join(project, "app", "config.py"));

    // No linter is on PATH, so the audit runs only its own deterministic scanners.
    const output = await withToolEnvironment({}, () => run(project));

    const inventory = readRecord(join(project, DATA, "inventory.json"));
    const findings = readRows(join(project, SCANNER_OUTPUT, "grep-scanner.jsonl"));
    expect(output).toContain("STATE: NEEDS_SCANNING");
    expect(inventory["stack"]).toBe("typescript");
    expect(Number(inventory["total_files"])).toBeGreaterThanOrEqual(4);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const rules = findings.map((finding) => finding["rule"]);
    expect(rules).toContain("R05");
    expect(rules).toContain("R09");
    expect(findings.filter((finding) => !CANONICAL_CATEGORIES.includes(String(finding["category"])))).toEqual([]);
  });
});
