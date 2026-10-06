import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { recoverPartialBatch } from "@rinnegan/handle_partial_scan.ts";
import { isOutputComplete, validateEnrichmentCompleteness } from "@rinnegan/output_validator.ts";

const OUTPUT = "findings.jsonl";
const PROGRESS_CLI = join(import.meta.dir, "..", "scripts", "check-scan-progress.ts");
const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");

interface CompletenessCase {
  name: string;
  output?: string;
  sentinel?: object;
  complete: boolean;
  sentinelAfter?: boolean;
}

describe("isOutputComplete", () => {
  it.each<CompletenessCase>([
    { name: "a sentinel whose line count matches the file", output: jsonl([{ a: 1 }, { b: 2 }]), sentinel: { lines: 2 }, complete: true },
    { name: "a sentinel whose line count does not match", output: jsonl([{ a: 1 }]), sentinel: { lines: 5 }, complete: false },
    { name: "a zero-line sentinel beside an empty file", output: "", sentinel: { lines: 0 }, complete: true },
    { name: "a sentinel with its output file missing", sentinel: { lines: 2 }, complete: false },
    { name: "blank lines do not count against the sentinel", output: `\n${jsonl([{ a: 1 }])}   \n${jsonl([{ b: 2 }])}\n`, sentinel: { lines: 2 }, complete: true },
    { name: "valid JSONL without a sentinel, which then gets one", output: jsonl([{ a: 1 }, { b: 2 }, { c: 3 }]), complete: true, sentinelAfter: true },
    { name: "a truncated last line without a sentinel", output: `${jsonl([{ valid: true }])}{"truncated": tru`, complete: false, sentinelAfter: false },
    { name: "an empty file without a sentinel", output: "", complete: false, sentinelAfter: false },
    { name: "no file and no sentinel", complete: false, sentinelAfter: false },
  ])("is $complete for $name", ({ output, sentinel, complete, sentinelAfter }) => {
    const files: Record<string, string> = {};
    if (output !== undefined) files[OUTPUT] = output;
    if (sentinel !== undefined) files[`${OUTPUT}.done`] = JSON.stringify(sentinel);
    const dir = projectFiles(files);
    const path = join(dir, OUTPUT);

    expect(isOutputComplete(path)).toBe(complete);

    if (sentinelAfter !== undefined) expect(existsSync(`${path}.done`)).toBe(sentinelAfter);
    if (sentinelAfter === true) {
      const recovered: unknown = JSON.parse(readFileSync(`${path}.done`, "utf8"));
      expect(isRecord(recovered) ? recovered["lines"] : undefined).toBe(3);
      expect(recovered).toMatchObject({ auto_recovered: true });
      expect(recovered).toHaveProperty("timestamp", expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00$/));
    }
  });
});

interface EnrichmentCase {
  name: string;
  findings: object[];
  enriched: Record<string, number>;
  complete: string[];
  incomplete: string[];
}

const layered = (layer: string, count: number): object[] => Array.from({ length: count }, (_, i) => ({ layer, rule: `R${i}` }));
const enrichedRows = (count: number): string => jsonl(Array.from({ length: count }, (_, i) => ({ e: i })));

describe("validateEnrichmentCompleteness", () => {
  it.each<EnrichmentCase>([
    { name: "every layer fully enriched", findings: [...layered("api", 2), ...layered("ui", 1)], enriched: { api: 2, ui: 1 }, complete: ["api", "ui"], incomplete: [] },
    { name: "a layer with no enrichment file", findings: [...layered("api", 1), ...layered("db", 1)], enriched: { api: 1 }, complete: ["api"], incomplete: ["db"] },
    { name: "a layer enriched to half its findings", findings: layered("api", 10), enriched: { api: 5 }, complete: [], incomplete: ["api"] },
    { name: "a layer enriched to exactly 80 percent", findings: layered("api", 10), enriched: { api: 8 }, complete: ["api"], incomplete: [] },
    { name: "findings without a layer", findings: [{ rule: "R05" }, ...layered("api", 1)], enriched: { api: 1 }, complete: ["api"], incomplete: [] },
  ])("sorts layers for $name", ({ findings, enriched, complete, incomplete }) => {
    const files: Record<string, string> = { "findings.jsonl": jsonl(findings) };
    for (const [layer, count] of Object.entries(enriched)) files[`enriched/${layer}.jsonl`] = enrichedRows(count);
    const dir = projectFiles(files);

    const result = validateEnrichmentCompleteness(join(dir, "findings.jsonl"), join(dir, "enriched"));

    expect(result).toEqual({ complete, incomplete });
  });
});

type Batch = { id: number; layer: string; files: string[]; status: string; output_file: string; finding_count: number };

const batch = (id: number, files: string[], layer = "services", status = "pending"): Batch => ({
  id,
  layer,
  files,
  status,
  output_file: `data/scanner-output/scanner-${id}-${layer}.jsonl`,
  finding_count: 0,
});

interface RecoveryCase {
  name: string;
  batches: Batch[];
  batchId: number;
  scanned: string[];
  repeat?: number;
  after: object[];
  total?: number;
}

const PLAN = "scan-plan.json";

describe("recoverPartialBatch", () => {
  it.each<RecoveryCase>([
    {
      name: "a partial scan queues a follow-up with the missing files",
      batches: [batch(1, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])],
      batchId: 1,
      scanned: ["a.ts", "b.ts", "c.ts"],
      after: [
        { id: 1, status: "partial", files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] },
        { id: 2, status: "pending", files: ["d.ts", "e.ts"], layer: "services", parent_batch: 1, finding_count: 0, output_file: "data/scanner-output/scanner-2-services.jsonl" },
      ],
      total: 2,
    },
    {
      name: "a scan of every file completes the batch",
      batches: [batch(1, ["a.ts", "b.ts", "c.ts"])],
      batchId: 1,
      scanned: ["a.ts", "b.ts", "c.ts"],
      after: [{ id: 1, status: "complete" }],
    },
    {
      name: "a scan of no file keeps the batch pending and counts a retry each time",
      batches: [batch(1, ["a.ts", "b.ts", "c.ts"])],
      batchId: 1,
      scanned: [],
      repeat: 2,
      after: [{ id: 1, status: "pending", retries: 2 }],
    },
    {
      name: "the follow-up takes the next id after the highest and its parent's layer",
      batches: [batch(1, ["a.ts", "b.ts"]), batch(2, ["c.ts", "d.ts"], "utils"), batch(5, ["e.ts", "f.ts", "g.ts"], "api")],
      batchId: 5,
      scanned: ["e.ts"],
      after: [{ id: 1 }, { id: 2 }, { id: 5, status: "partial" }, { id: 6, layer: "api", files: ["f.ts", "g.ts"], output_file: "data/scanner-output/scanner-6-api.jsonl" }],
      total: 4,
    },
    {
      name: "the other batches are left as they were",
      batches: [batch(1, ["a.ts", "b.ts"], "services", "complete"), batch(2, ["c.ts", "d.ts", "e.ts"], "utils")],
      batchId: 2,
      scanned: ["c.ts"],
      after: [{ id: 1, status: "complete", files: ["a.ts", "b.ts"] }, { id: 2, status: "partial" }, { id: 3, files: ["d.ts", "e.ts"], parent_batch: 2 }],
      total: 3,
    },
  ])("$name", ({ batches, batchId, scanned, repeat, after, total }) => {
    const dir = projectFiles({ [PLAN]: JSON.stringify({ total_batches: batches.length, completed: 0, batches }, null, 2) });
    const planPath = join(dir, PLAN);

    for (let run = 0; run < (repeat ?? 1); run += 1) recoverPartialBatch(planPath, batchId, scanned);

    const plan: unknown = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan).toMatchObject({ batches: after, total_batches: total ?? batches.length });
    expect(isRecord(plan) && Array.isArray(plan["batches"]) ? plan["batches"].length : -1).toBe(after.length);
  });

  it("refuses a batch the plan does not hold", () => {
    const planPath = join(projectFiles({ [PLAN]: JSON.stringify({ total_batches: 1, completed: 0, batches: [batch(1, ["a.ts"])] }) }), PLAN);

    expect(() => recoverPartialBatch(planPath, 99, ["a.ts"])).toThrow("Batch 99 not found");
  });
});

interface ProgressCase {
  name: string;
  batches: Batch[];
  stdout: string;
}

const pending = (id: number): Batch => batch(id, [`f${id}.ts`, `g${id}.ts`], "utils");
const pendingBlock = (id: number): string => `  PENDING: batch ${id} layer=utils output=data/scanner-output/scanner-${id}-utils.jsonl file_count=2\n  FILES: f${id}.ts g${id}.ts\n`;

describe("the check-scan-progress command", () => {
  it.each<ProgressCase>([
    {
      name: "one batch left to scan",
      batches: [batch(1, ["a.ts"], "services", "complete"), pending(2)],
      stdout: `SCAN_PROGRESS: 1/2 complete, 1 pending\n${pendingBlock(2)}`,
    },
    {
      name: "every batch complete",
      batches: [batch(1, ["a.ts"], "services", "complete"), batch(2, ["b.ts"], "utils", "complete")],
      stdout: "SCAN_PROGRESS: 2/2 complete, 0 pending\nALL_BATCHES_COMPLETE\n",
    },
    {
      name: "seven pending batches, of which the first five are listed and a partial one is not counted",
      batches: [batch(1, ["a.ts"], "services", "partial"), ...[2, 3, 4, 5, 6, 7, 8].map(pending)],
      stdout: `SCAN_PROGRESS: 0/8 complete, 7 pending\n${[2, 3, 4, 5, 6].map(pendingBlock).join("")}`,
    },
  ])("reports $name", ({ batches, stdout }) => {
    const dir = projectFiles({ "data/scan-plan.json": JSON.stringify({ total_batches: batches.length, completed: 0, batches }) });

    const run = Bun.spawnSync([process.execPath, PROGRESS_CLI, dir], { stdout: "pipe", stderr: "pipe" });

    expect([run.exitCode, run.stdout.toString()]).toEqual([0, stdout]);
  });
});
