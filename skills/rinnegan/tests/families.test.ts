import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { collapseFindingFamilies } from "@rinnegan/finding_families.ts";

type Row = Record<string, unknown>;

const FINDINGS_PATH = join("data", "findings.jsonl");
const FAMILIES_PATH = join("data", "finding-families.json");
const FAMILIES_CLI = join(import.meta.dir, "..", "scripts", "finding_families.ts");

const duplicate = (id: string, file: string, overrides: Row = {}): Row => ({
  id,
  rule: "R01",
  severity: "CRITICAL",
  file,
  line: 10,
  description: "DEFAULT_BASE_URL duplicated",
  search_pattern: "DEFAULT_BASE_URL",
  ...overrides,
});

function auditWith(rows: Row[]): string {
  return projectFiles({ [FINDINGS_PATH]: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
}

function readRows(audit: string): Row[] {
  return readFileSync(join(audit, FINDINGS_PATH), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Row => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError(`not an object row: ${line}`);
      return parsed;
    });
}

interface FamilyCase {
  name: string;
  rows: Row[];
  again?: boolean;
  families: number;
  familiesFile?: object;
  after: [id: string, severity: string, parent: string | undefined, root: boolean | undefined][];
}

describe("collapseFindingFamilies", () => {
  it.each<FamilyCase>([
    {
      name: "the same R01 pattern in two files becomes a family with a root and a demoted subordinate",
      rows: [duplicate("DRY-001", "src/a.ts"), duplicate("DRY-002", "src/b.ts")],
      families: 1,
      familiesFile: {
        families: [
          {
            id: "FAM-001",
            rule: "R01",
            pattern_key: "default base url",
            root_finding_id: "DRY-001",
            root_severity: "CRITICAL",
            member_finding_ids: ["DRY-001", "DRY-002"],
            subordinate_finding_ids: ["DRY-002"],
            distinct_files: ["src/a.ts", "src/b.ts"],
            family_size: 2,
            description: "DEFAULT_BASE_URL duplicated",
          },
        ],
        summary: { families_created: 1, root_causes: 1, subordinate_findings: 1 },
      },
      after: [
        ["DRY-001", "CRITICAL", undefined, true],
        ["DRY-002", "HIGH", "DRY-001", false],
      ],
    },
    {
      name: "the highest severity is the root wherever it sits",
      rows: [duplicate("DRY-001", "src/a.ts", { severity: "MEDIUM" }), duplicate("DRY-002", "src/b.ts", { severity: "HIGH" })],
      families: 1,
      after: [
        ["DRY-001", "LOW", "DRY-002", false],
        ["DRY-002", "HIGH", undefined, true],
      ],
    },
    {
      name: "a tie on severity goes to the earlier phase",
      rows: [duplicate("DRY-001", "src/a.ts", { phase: 3 }), duplicate("DRY-002", "src/b.ts", { phase: 1 })],
      families: 1,
      after: [
        ["DRY-001", "HIGH", "DRY-002", false],
        ["DRY-002", "CRITICAL", undefined, true],
      ],
    },
    {
      name: "a tie on severity and phase goes to the earlier file",
      rows: [duplicate("DRY-001", "src/b.ts"), duplicate("DRY-002", "src/a.ts")],
      families: 1,
      after: [
        ["DRY-001", "HIGH", "DRY-002", false],
        ["DRY-002", "CRITICAL", undefined, true],
      ],
    },
    {
      name: "spelling, case and numbers do not separate one pattern",
      rows: [duplicate("DRY-001", "src/a.ts", { search_pattern: "DEFAULT_BASE_URL" }), duplicate("DRY-002", "src/b.ts", { search_pattern: "default-base-url #42" })],
      families: 1,
      after: [
        ["DRY-001", "CRITICAL", undefined, true],
        ["DRY-002", "HIGH", "DRY-001", false],
      ],
    },
    {
      name: "repeats within one file are not a family",
      rows: [duplicate("DRY-001", "src/a.ts"), duplicate("DRY-002", "src/a.ts", { line: 20 })],
      families: 0,
      familiesFile: { families: [], summary: { families_created: 0, root_causes: 0, subordinate_findings: 0 } },
      after: [
        ["DRY-001", "CRITICAL", undefined, undefined],
        ["DRY-002", "CRITICAL", undefined, undefined],
      ],
    },
    {
      name: "only R01 findings can form a family",
      rows: [duplicate("SEC-001", "src/a.ts", { rule: "R05" }), duplicate("SEC-002", "src/b.ts", { rule: "R05" })],
      families: 0,
      after: [
        ["SEC-001", "CRITICAL", undefined, undefined],
        ["SEC-002", "CRITICAL", undefined, undefined],
      ],
    },
    {
      name: "REVIEW findings stay out of a family",
      rows: [duplicate("DRY-001", "src/a.ts", { severity: "REVIEW" }), duplicate("DRY-002", "src/b.ts")],
      families: 0,
      after: [
        ["DRY-001", "REVIEW", undefined, undefined],
        ["DRY-002", "CRITICAL", undefined, undefined],
      ],
    },
    {
      name: "collapsing again keeps the same membership and severities",
      rows: [duplicate("DRY-001", "src/a.ts"), duplicate("DRY-002", "src/b.ts"), duplicate("DRY-003", "src/c.ts", { severity: "LOW" })],
      again: true,
      families: 1,
      after: [
        ["DRY-001", "CRITICAL", undefined, true],
        ["DRY-002", "HIGH", "DRY-001", false],
        ["DRY-003", "LOW", "DRY-001", false],
      ],
    },
  ])("$name", ({ rows, again, families, familiesFile, after }) => {
    const audit = auditWith(rows);

    let result = collapseFindingFamilies(audit);
    if (again === true) result = collapseFindingFamilies(audit);

    expect(result.families_created).toBe(families);
    expect(readRows(audit).map((row) => [row["id"], row["severity"], row["parent_finding_id"], row["is_root_cause"]])).toEqual(after);
    if (familiesFile !== undefined) expect(readFileSync(join(audit, FAMILIES_PATH), "utf8")).toBe(JSON.stringify(familiesFile, null, 2) + "\n");
  });
});

describe("the finding_families command", () => {
  it.each([
    { name: "collapses the audit's findings and reports the counts", withAudit: true, status: 0, stdout: "FAMILY_COLLAPSE_COMPLETE families=1 subordinates=1\n" },
    { name: "prints its usage without an audit directory", withAudit: false, status: 1, stdout: "Usage: finding_families.ts <audit_dir>\n" },
  ])("$name", ({ withAudit, status, stdout }) => {
    const args = withAudit ? [auditWith([duplicate("DRY-001", "src/a.ts"), duplicate("DRY-002", "src/b.ts")])] : [];

    const run = Bun.spawnSync([process.execPath, FAMILIES_CLI, ...args], { stdout: "pipe", stderr: "pipe" });

    expect([run.exitCode, run.stdout.toString()]).toEqual([status, stdout]);
  });
});
