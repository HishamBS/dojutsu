import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { applyCrossCutting } from "@rinnegan/detect_cross_cutting.ts";
import { mergeEnriched } from "@rinnegan/merge-enriched.ts";

type Row = Record<string, unknown>;

const FINDINGS = join("data", "findings.jsonl");
const MERGE_CLI = join(import.meta.dir, "..", "scripts", "merge-enriched.ts");
const jsonl = (rows: Row[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");

const finding = (overrides: Row = {}): Row => ({
  id: "CLN-001",
  rule: "R09",
  severity: "MEDIUM",
  category: "clean-code",
  file: "src/a.ts",
  line: 1,
  description: "console.log left in production code",
  search_pattern: "console.log",
  confidence: "medium",
  ...overrides,
});

function auditWith(original: Row[], enriched: Record<string, Row[]>): string {
  const files: Record<string, string> = { [FINDINGS]: jsonl(original) };
  for (const [name, rows] of Object.entries(enriched)) files[join("data", "enriched", name)] = jsonl(rows);
  return projectFiles(files);
}

function readRows(audit: string): Row[] {
  return readFileSync(join(audit, FINDINGS), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Row => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError(`not an object row: ${line}`);
      return parsed;
    });
}

interface MergeCase {
  name: string;
  original: Row[];
  enriched: Record<string, Row[]>;
  result: { count: number; previousCount: number; groups?: number };
  rows: Row[];
}

const unscored = (rule: string, description: string): Row => finding({ rule, description, confidence: undefined });
const placeholder = (): Row[] => [finding()];

describe("mergeEnriched", () => {
  it.each<MergeCase>([
    {
      name: "enriched files, read in file-name order, replacing the findings with no backup left",
      original: [finding({ id: "A" }), finding({ id: "B", line: 2 })],
      enriched: { "b.jsonl": [finding({ id: "C", line: 3 })], "a.jsonl": [finding({ id: "A", line: 1 }), finding({ id: "B", line: 2 })] },
      result: { count: 3, previousCount: 2 },
      rows: [{ id: "A" }, { id: "B" }, { id: "C" }],
    },
    {
      name: "a R04 loop finding as high confidence",
      original: placeholder(),
      enriched: { "a.jsonl": [unscored("R04", "Allocation inside a loop")] },
      result: { count: 1, previousCount: 1 },
      rows: [{ confidence: "high", confidence_reason: "HIGH: performance issue in loop/iterator (R04-H1/H3)" }],
    },
    {
      name: "a R04 inline handler as medium confidence",
      original: placeholder(),
      enriched: { "a.jsonl": [unscored("R04", "Inline handler recreated")] },
      result: { count: 1, previousCount: 1 },
      rows: [{ confidence: "medium", confidence_reason: "MEDIUM: inline handler (R04-M1)" }],
    },
    {
      name: "a R11 hook export as high confidence",
      original: placeholder(),
      enriched: { "a.jsonl": [unscored("R11", "Exported hook has no JSDoc")] },
      result: { count: 1, previousCount: 1 },
      rows: [{ confidence: "high", confidence_reason: "HIGH: complex export without JSDoc (R11-H1/H2)" }],
    },
    {
      name: "a R13 timeout as high confidence and a R13 css value as low",
      original: [finding(), finding({ line: 2 })],
      enriched: { "a.jsonl": [unscored("R13", "Timeout of 30 seconds"), unscored("R13", "Padding in css")] },
      result: { count: 2, previousCount: 2 },
      rows: [
        { confidence: "high", confidence_reason: "HIGH: business logic constant (R13-H1)" },
        { confidence: "low", confidence_reason: "LOW: CSS value (R13-L1)" },
      ],
    },
    {
      name: "a R09 console.error as low confidence",
      original: placeholder(),
      enriched: { "a.jsonl": [unscored("R09", "console.error in catch")] },
      result: { count: 1, previousCount: 1 },
      rows: [{ confidence: "low", confidence_reason: "LOW: console.error in catch (R09-L1)" }],
    },
    {
      name: "any other rule as high confidence, and a stated confidence kept",
      original: [finding(), finding({ line: 2 })],
      enriched: { "a.jsonl": [unscored("R05", "TLS disabled"), finding({ line: 2, confidence: "low", confidence_reason: "scanner said so" })] },
      result: { count: 2, previousCount: 2 },
      rows: [
        { confidence: "high", confidence_reason: "HIGH: R05 violations are precise" },
        { confidence: "low", confidence_reason: "scanner said so" },
      ],
    },
    {
      name: "categories fixed by rule, severities uppercased or defaulted, and a row without its file dropped",
      original: [finding(), finding({ line: 2 }), finding({ line: 3 }), finding({ line: 4 }), finding({ line: 5 })],
      enriched: {
        "a.jsonl": [
          finding({ category: "Clean Code" }),
          finding({ rule: "R05", category: "SECURITY", severity: "high", line: 2 }),
          finding({ file: "", line: 3 }),
          finding({ line: 4, severity: "banana" }),
          finding({ line: 5, severity: undefined }),
        ],
      },
      result: { count: 5, previousCount: 5 },
      rows: [{ category: "clean-code" }, { category: "security", severity: "HIGH" }, { severity: "MEDIUM" }, { severity: "MEDIUM" }],
    },
    {
      name: "one pattern across three files marked as a cross-cutting group",
      original: [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" }), finding({ file: "src/c.ts" })],
      enriched: { "a.jsonl": [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" }), finding({ file: "src/c.ts" })] },
      result: { count: 3, previousCount: 3, groups: 1 },
      rows: [0, 1, 2].map(() => ({ cross_cutting: true, cross_cutting_group: "R09 across 3 files" })),
    },
  ])("merges $name", ({ original, enriched, result, rows }) => {
    const audit = auditWith(original, enriched);

    const merged = mergeEnriched(audit);

    expect(merged).toMatchObject(result);
    const after = readRows(audit);
    expect(after).toHaveLength(rows.length);
    rows.forEach((want, index) => expect(after[index]).toMatchObject(want));
    expect(existsSync(join(audit, `${FINDINGS}.bak`))).toBe(false);
    expect(existsSync(join(audit, `${FINDINGS}.tmp`))).toBe(false);
  });

  it("refuses an enrichment that lost findings and leaves the original bytes alone", () => {
    const audit = auditWith(
      [finding({ id: "A" }), finding({ id: "B", line: 2 }), finding({ id: "C", line: 3 })],
      { "a.jsonl": [finding({ id: "A" }), finding({ id: "B", line: 2 })] },
    );
    const before = readFileSync(join(audit, FINDINGS), "utf8");

    expect(() => mergeEnriched(audit)).toThrow("Lost 1 findings");

    expect(readFileSync(join(audit, FINDINGS), "utf8")).toBe(before);
    expect(existsSync(join(audit, `${FINDINGS}.bak`))).toBe(false);
    expect(existsSync(join(audit, `${FINDINGS}.tmp`))).toBe(false);
  });
});

interface CrossCase {
  name: string;
  rows: Row[];
  minFiles?: number;
  groups: number;
  marked: boolean[];
}

const spread = (rule: string, files: string[], overrides: Row = {}): Row[] =>
  files.map((file, index) => finding({ id: `${rule}-${index}`, rule, file, search_pattern: "console.log", ...overrides }));

describe("applyCrossCutting", () => {
  it.each<CrossCase>([
    { name: "one rule and pattern across three files", rows: spread("R09", ["a.ts", "b.ts", "c.ts"]), groups: 1, marked: [true, true, true] },
    { name: "a pattern across only two files", rows: spread("R05", ["a.ts", "b.ts"]), groups: 0, marked: [false, false] },
    { name: "one file twice and another once, which is two files", rows: spread("R09", ["a.ts", "a.ts", "b.ts"]), groups: 0, marked: [false, false, false] },
    {
      name: "one pattern under two rules, no rule reaching three files",
      rows: [...spread("R09", ["a.ts", "c.ts"]), ...spread("R05", ["b.ts"])],
      groups: 0,
      marked: [false, false, false],
    },
    { name: "four files against the default of three", rows: spread("R09", ["a.ts", "b.ts", "c.ts", "d.ts"]), groups: 1, marked: [true, true, true, true] },
    { name: "two files against a lowered threshold", rows: spread("R09", ["a.ts", "b.ts"]), minFiles: 2, groups: 1, marked: [true, true] },
    {
      name: "findings without a search pattern grouped by their description",
      rows: spread("R09", ["a.ts", "b.ts", "c.ts"], { search_pattern: undefined, description: "same words in every file" }),
      groups: 1,
      marked: [true, true, true],
    },
  ])("finds $name", ({ rows, minFiles, groups, marked }) => {
    const path = join(projectFiles({ "findings.jsonl": jsonl(rows) }), "findings.jsonl");

    const found = minFiles === undefined ? applyCrossCutting(path) : applyCrossCutting(path, minFiles);

    expect(found).toBe(groups);
    const after = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line));
    expect(after.map((row) => isRecord(row) && row["cross_cutting"] === true)).toEqual(marked);
  });
});

describe("the merge-enriched command", () => {
  it.each<{ name: string; enriched: Row[]; status: number; stdout: string }>([
    {
      name: "reports a merge",
      enriched: [finding({ id: "A" }), finding({ id: "B", line: 2 })],
      status: 0,
      stdout: "Merged: 2 findings (was 2)\nNormalized: 2 findings to canonical categories\nCross-cutting: 0 groups detected\n",
    },
    {
      name: "refuses a merge that lost findings",
      enriched: [finding({ id: "A" })],
      status: 1,
      stdout: "Merged: 1 findings (was 2)\nWARNING: Lost 1 findings! The original findings.jsonl is unchanged.\n",
    },
  ])("$name", ({ enriched, status, stdout }) => {
    const audit = auditWith([finding({ id: "A" }), finding({ id: "B", line: 2 })], { "a.jsonl": enriched });

    const run = Bun.spawnSync([process.execPath, MERGE_CLI, audit], { stdout: "pipe", stderr: "pipe" });

    expect([run.exitCode, run.stdout.toString()]).toEqual([status, stdout]);
  });
});
