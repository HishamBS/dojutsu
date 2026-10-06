import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { aggregate } from "@rinnegan/aggregate_findings.ts";
import { validateScannerFile } from "@rinnegan/validate_scanner_output.ts";

type Row = Record<string, unknown>;

const SCANNER_FILE = "scanner.jsonl";
const VALIDATE_CLI = join(import.meta.dir, "..", "scripts", "validate_scanner_output.ts");

function row(overrides: Row = {}, omit: string[] = []): Row {
  const base: Row = {
    rule: "R05",
    file: "src/app.ts",
    line: 10,
    description: "TLS validation disabled",
    severity: "HIGH",
    category: "security",
    confidence: "high",
    ...overrides,
  };
  for (const key of omit) delete base[key];
  return base;
}

function scannerFile(lines: (Row | string)[]): string {
  const content = lines.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n") + "\n";
  return join(projectFiles({ [SCANNER_FILE]: content }), SCANNER_FILE);
}

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

interface ValidateCase {
  name: string;
  lines: (Row | string)[];
  inventory?: string[];
  batchLoc?: number;
  valid: number;
  rejected: number;
  reasons?: string[];
  kept?: Row[];
  warnings?: string[];
}

const LOW_VALUE_WARNING = "findings in 100 LOC is 30 per KLOC, above 20 per KLOC. Check for low-value findings that match a SKIP criterion.";
const unreviewed = (rule: string, line: number): Row => row({ rule, line });
const capped = (confidence: string | undefined, severity: string): Row =>
  row({ rule: "R02", category: "architecture", severity }, confidence === undefined ? ["confidence"] : []);
const withConfidence = (confidence: string): Row => ({ ...capped(undefined, "CRITICAL"), confidence });

describe("validateScannerFile", () => {
  it.each<ValidateCase>([
    {
      name: "valid rows pass through in order",
      lines: [row(), row({ rule: "R07", line: 20, category: "typing" })],
      valid: 2,
      rejected: 0,
      kept: [{ rule: "R05" }, { rule: "R07" }],
    },
    ...["rule", "file", "line", "description"].map(
      (field): ValidateCase => ({ name: `a row without ${field} is rejected`, lines: [row({}, [field])], valid: 0, rejected: 1, reasons: [`missing_fields:${field}`] }),
    ),
    {
      name: "a file missing from the inventory is rejected as a phantom",
      lines: [row({ file: "nonexistent/file.ts" })],
      inventory: ["src/app.ts", "src/utils.ts"],
      valid: 0,
      rejected: 1,
      reasons: ["phantom_file:nonexistent/file.ts"],
    },
    { name: "a file in the inventory passes", lines: [row()], inventory: ["src/app.ts", "src/utils.ts"], valid: 1, rejected: 0 },
    { name: "any file passes without an inventory", lines: [row({ file: "anything/goes.ts" })], valid: 1, rejected: 0 },
    { name: "malformed JSON is rejected beside valid rows", lines: ["this is not json at all", row()], valid: 1, rejected: 1, reasons: ["invalid_json"] },
    { name: "a JSON array is rejected", lines: ["[1, 2, 3]"], valid: 0, rejected: 1, reasons: ["not_a_dict"] },
    { name: "blank lines are skipped", lines: ["", row(), ""], valid: 1, rejected: 0 },
    { name: "a zero line number is rejected", lines: [row({ line: 0 })], valid: 0, rejected: 1 },
    { name: "a negative line number is rejected", lines: [row({ line: -5 })], valid: 0, rejected: 1, reasons: ["invalid_line_number:-5"] },
    { name: "a string line number is rejected", lines: [row({ line: "ten" })], valid: 0, rejected: 1, reasons: ["invalid_line_number:ten"] },
    {
      name: "the rule decides the category over the written text",
      lines: [row({ rule: "R07", category: "strict typing" }), row({ rule: "R05", category: "Clean Code", line: 11 })],
      valid: 2,
      rejected: 0,
      kept: [{ category: "typing" }, { category: "security" }],
    },
    {
      name: "a category the rule table lacks is normalized from its text",
      lines: [
        row({ rule: "R99", category: "TYPE" }),
        row({ rule: "R99", category: "SSOT/DRY", line: 11 }),
        row({ rule: "R99", category: "Separation of Concerns", line: 12 }),
        row({ rule: "R99", category: "unknown_thing", line: 13 }),
      ],
      valid: 4,
      rejected: 0,
      kept: [{ category: "typing" }, { category: "ssot-dry" }, { category: "architecture" }, { category: "clean-code" }],
    },
    {
      name: "severity is uppercased, and an unknown one becomes MEDIUM",
      lines: [row({ severity: "high" }), row({ severity: "URGENT", line: 11 }), row({ severity: "CRITICAL", line: 12 })],
      valid: 3,
      rejected: 0,
      kept: [{ severity: "HIGH" }, { severity: "MEDIUM" }, { severity: "CRITICAL" }],
    },
    {
      name: "confidence caps severity: low to MEDIUM, medium to HIGH, high keeps CRITICAL",
      lines: [withConfidence("low"), { ...withConfidence("medium"), line: 11 }, { ...withConfidence("high"), line: 12 }, { ...capped(undefined, "CRITICAL"), line: 13 }],
      valid: 4,
      rejected: 0,
      kept: [
        { severity: "MEDIUM", severity_capped_from: "CRITICAL" },
        { severity: "HIGH", severity_capped_from: "CRITICAL" },
        { severity: "CRITICAL" },
        { severity: "MEDIUM", severity_capped_from: "CRITICAL" },
      ],
    },
    {
      name: "one rule above 60 percent of the rows draws a density warning",
      lines: [...Array.from({ length: 8 }, (_, i) => unreviewed("R13", i + 1)), ...Array.from({ length: 2 }, (_, i) => unreviewed("R05", i + 20))],
      valid: 10,
      rejected: 0,
      warnings: ["Rule R13 produces 8/10 findings (80%), exceeding 60% threshold. Check for over-reporting."],
    },
    {
      name: "no density warning at 40 percent",
      lines: [
        ...Array.from({ length: 3 }, (_, i) => unreviewed("R05", i + 1)),
        ...Array.from({ length: 3 }, (_, i) => row({ rule: "R07", line: i + 10, category: "typing" })),
        ...Array.from({ length: 4 }, (_, i) => unreviewed("R13", i + 20)),
      ],
      valid: 10,
      rejected: 0,
      warnings: [],
    },
    {
      name: "3 findings in 100 LOC is above 20 per KLOC",
      lines: [unreviewed("R05", 1), unreviewed("R09", 2), unreviewed("R13", 3)],
      batchLoc: 100,
      valid: 3,
      rejected: 0,
      warnings: [`3 ${LOW_VALUE_WARNING}`],
    },
    { name: "2 findings in 100 LOC is exactly 20 per KLOC", lines: [unreviewed("R05", 1), unreviewed("R09", 2)], batchLoc: 100, valid: 2, rejected: 0, warnings: [] },
    {
      name: "1 finding in 1000 LOC is 1 per KLOC, though its rule is the whole file",
      lines: [unreviewed("R05", 1)],
      batchLoc: 1000,
      valid: 1,
      rejected: 0,
      warnings: ["Rule R05 produces 1/1 findings (100%), exceeding 60% threshold. Check for over-reporting."],
    },
  ])("$name", ({ lines, inventory, batchLoc, valid, rejected, reasons, kept, warnings }) => {
    const path = scannerFile(lines);

    const result = validateScannerFile(path, inventory === undefined ? undefined : new Set(inventory), batchLoc);

    expect([result.valid, result.rejected]).toEqual([valid, rejected]);
    if (warnings !== undefined) expect(result.warnings).toEqual(warnings);
    if (reasons !== undefined) {
      const rejectedRows = readRows(`${path}.rejected`);
      expect(rejectedRows.map((entry) => entry["_reason"])).toEqual(reasons);
    }
    if (kept !== undefined) {
      const rows = readRows(path);
      expect(rows).toHaveLength(kept.length);
      kept.forEach((want, index) => {
        expect(rows[index]).toMatchObject(want);
        if (want["severity_capped_from"] === undefined) expect(rows[index]).not.toHaveProperty("severity_capped_from");
      });
    }
  });

  it("keeps the rejects beside the file with their line numbers, and drops a stale reject file", () => {
    const path = scannerFile(["", row({}, ["rule"]), row()]);

    validateScannerFile(path);

    const rejectedRows = readRows(`${path}.rejected`);
    expect(rejectedRows.map((entry) => [entry["_reason"], entry["_line"]])).toEqual([["missing_fields:rule", 2]]);

    validateScannerFile(path);

    expect(existsSync(`${path}.rejected`)).toBe(false);
  });
});

describe("the validate_scanner_output command", () => {
  it("reports the counts and where the rejected rows went, judging files against the inventory", () => {
    const path = scannerFile([row(), row({ rule: "R07", line: 2, category: "typing" }), row({ file: "gone.ts" })]);
    const inventory = join(projectFiles({ "inventory.json": JSON.stringify({ files: [{ path: "src/app.ts" }] }) }), "inventory.json");

    const run = Bun.spawnSync([process.execPath, VALIDATE_CLI, path, inventory], { stdout: "pipe", stderr: "pipe" });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`validate: 2 valid, 1 rejected\n  Rejected findings written to: ${path}.rejected\n`);
  });
});

const scanned = (overrides: Row = {}): Row => ({
  rule: "R09",
  severity: "MEDIUM",
  category: "clean-code",
  file: "src/app.ts",
  line: 10,
  snippet: "console.log(order)",
  description: "console.log left in production code",
  explanation: "Logs leak internals.",
  search_pattern: "console.log",
  phase: 5,
  effort: "low",
  scanner: "grep-scanner",
  ...overrides,
});

const INVENTORY_LAYER = "app";

function auditWithScannerOutput(outputs: Record<string, Row[]>): string {
  const paths = [...new Set(Object.values(outputs).flatMap((rows) => rows.map((entry) => String(entry["file"]))))].sort();
  const files: Record<string, string> = {
    "data/inventory.json": JSON.stringify({ root: "proj", stack: "typescript", framework: "none", files: paths.map((path) => ({ path, loc: 10, layer: INVENTORY_LAYER })) }),
  };
  for (const [name, rows] of Object.entries(outputs)) files[`data/scanner-output/${name}`] = rows.map((entry) => JSON.stringify(entry) + "\n").join("");
  return projectFiles(files);
}

function aggregated(outputs: Record<string, Row[]>): Row[] {
  const audit = auditWithScannerOutput(outputs);
  aggregate(audit);
  return readRows(join(audit, "data", "findings.jsonl"));
}

interface AggregateCase {
  name: string;
  outputs: Record<string, Row[]>;
  expected: Row[];
  absent?: string[];
}

const LONG_EXPLANATION = "A longer explanation of the leak.";

describe("aggregate", () => {
  it.each<AggregateCase>([
    {
      name: "one finding per file, line and rule, the higher severity surviving, crediting both scanners",
      outputs: {
        "grep-scanner.jsonl": [scanned({ scanner: "grep-scanner", severity: "LOW" })],
        "scanner-1-app.jsonl": [scanned({ scanner: "app", severity: "HIGH" })],
      },
      expected: [{ severity: "HIGH", scanner: "app,grep-scanner" }],
    },
    {
      name: "the longer explanation winning a tie on severity",
      outputs: {
        "grep-scanner.jsonl": [scanned({ scanner: "grep-scanner", explanation: "Short." })],
        "scanner-1-app.jsonl": [scanned({ scanner: "app", explanation: LONG_EXPLANATION })],
      },
      expected: [{ explanation: LONG_EXPLANATION, scanner: "app,grep-scanner" }],
    },
    {
      name: "different rules at one line staying apart",
      outputs: {
        "grep-scanner.jsonl": [scanned({ rule: "R09" })],
        "scanner-1-app.jsonl": [scanned({ rule: "R13", description: "magic number 30 in timeout" })],
      },
      expected: [{ rule: "R09" }, { rule: "R13" }],
    },
    {
      name: "ids counted per category prefix in phase, file, line order, with the inventory's layer",
      outputs: {
        "scanner-1-app.jsonl": [
          scanned({ category: "clean-code", phase: 5, file: "src/b.ts", line: 3, layer: "misc" }),
          scanned({ rule: "R05", category: "security", phase: 1, file: "src/b.ts", line: 9, search_pattern: "eval(" }),
          scanned({ rule: "R05", category: "security", phase: 1, file: "src/a.ts", line: 20, search_pattern: "eval(" }),
          scanned({ category: "clean-code", phase: 5, file: "src/a.ts", line: 1, layer: "misc" }),
        ],
      },
      expected: [
        { id: "SEC-001", file: "src/a.ts", line: 20, layer: INVENTORY_LAYER },
        { id: "SEC-002", file: "src/b.ts", line: 9, layer: INVENTORY_LAYER },
        { id: "CLN-001", file: "src/a.ts", line: 1, layer: INVENTORY_LAYER },
        { id: "CLN-002", file: "src/b.ts", line: 3, layer: INVENTORY_LAYER },
      ],
    },
    {
      name: "nearby restatements with one search pattern merging into the lower line",
      outputs: {
        "scanner-1-app.jsonl": [
          scanned({ line: 10, severity: "LOW", explanation: "Short.", snippet: "console.log(order)", description: "console.log call left in production code" }),
          scanned({
            line: 13,
            severity: "HIGH",
            explanation: LONG_EXPLANATION,
            snippet: "console.log(total)",
            description: "console.log call left in the production bundle",
          }),
        ],
      },
      expected: [{ line: 10, end_line: 13, severity: "HIGH", explanation: LONG_EXPLANATION, snippet: "console.log(order)\nconsole.log(total)" }],
    },
    {
      name: "nearby restatements with different search patterns staying apart",
      outputs: {
        "scanner-1-app.jsonl": [
          scanned({ line: 10, severity: "LOW", explanation: "Short.", snippet: "console.log(order)", description: "console.log call left in production code" }),
          scanned({
            line: 13,
            severity: "HIGH",
            explanation: LONG_EXPLANATION,
            snippet: "console.log(total)",
            description: "console.log call left in the production bundle",
            search_pattern: "console.error",
          }),
        ],
      },
      expected: [
        { line: 10, severity: "LOW", explanation: "Short.", snippet: "console.log(order)" },
        { line: 13, severity: "HIGH", explanation: LONG_EXPLANATION, snippet: "console.log(total)" },
      ],
      absent: ["end_line"],
    },
  ])("keeps $name", ({ outputs, expected, absent }) => {
    const rows = aggregated(outputs);

    expect(rows).toHaveLength(expected.length);
    expected.forEach((want, index) => expect(rows[index]).toMatchObject(want));
    for (const field of absent ?? []) rows.forEach((entry) => expect(entry).not.toHaveProperty(field));
  });

  it("records the project config and the finding count, leaving the sentinel for last", () => {
    const audit = auditWithScannerOutput({
      "grep-scanner.jsonl": [scanned({ line: 1 })],
      "scanner-1-app.jsonl": [scanned({ line: 40, rule: "R13", description: "magic number" })],
    });
    const outputDir = join(audit, "data", "scanner-output");
    for (const leftover of ["grep-scanner.status", "grep-scanner.jsonl.done", "scanner-1-app.jsonl.rejected"]) writeFileSync(join(outputDir, leftover), "{}\n");

    const count = aggregate(audit);

    expect(count).toBe(2);
    expect(readFileSync(join(audit, "data", "config.json"), "utf8")).toBe(`${JSON.stringify({ stack: "typescript", framework: "none", project: "proj" }, null, 2)}\n`);
    const done: unknown = JSON.parse(readFileSync(join(audit, "data", "findings.jsonl.done"), "utf8"));
    expect(done).toMatchObject({ lines: 2, scanner_files_processed: 2 });
    expect(done).toHaveProperty("timestamp", expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00$/));
    expect(statSync(join(audit, "data", "findings.jsonl.done")).mtimeMs).toBeGreaterThanOrEqual(statSync(join(audit, "data", "findings.jsonl")).mtimeMs);
  });
});
