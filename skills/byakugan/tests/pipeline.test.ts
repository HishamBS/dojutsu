import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { impactOutputStatus, mergeImpactAnalysisOutputs } from "@byakugan/merge_impact_analysis.ts";
import { getState, runPipeline } from "@byakugan/run_pipeline_lib.ts";

type Json = Record<string, unknown>;

const DEEP = "docs/audit/deep";
const PARTS = `${DEEP}/impact-analysis-parts`;
const FINAL = `${DEEP}/impact-analysis.jsonl`;
const MANIFEST = `${DEEP}/impact-analysis-manifest.json`;

const clustersFile = (...ids: string[]): Record<string, string> => ({ [`${DEEP}/clusters.json`]: JSON.stringify({ clusters: ids.map((id) => ({ id })) }) });

function validPart(id: string, overrides: Json = {}): Json {
  return {
    cluster_id: id,
    cluster_label: "Shared defaults",
    analyzed_at: "2026-04-15T00:00:00+00:00",
    source_files_read: ["src/a.ts", "src/b.ts"],
    read_count: 2,
    findings: [
      { finding_id: "DRY-001", file: "src/a.ts", line: 10 },
      { finding_id: "DRY-002", file: "src/b.ts", line: 12 },
    ],
    cluster_narrative: { root_cause: "duplication", systemic_pattern: "repeated wrapper defaults", business_impact: "clients drift", why_it_exists: "missing shared constants" },
    recommended_approach: {
      strategy: "extract_and_replace",
      description: "Move shared defaults into a single module.",
      fix_order: ["DRY-001", "DRY-002"],
      fix_blast_radius_files: 3,
      risk_assessment: "Moderate risk if callers depend on local overrides.",
      validation_steps: ["Run byakugan merge tests", "Rebuild affected generators"],
    },
    ...overrides,
  };
}

const partFile = (id: string, content: Json | string = validPart(id)): Record<string, string> => ({ [`${PARTS}/${id}.json`]: typeof content === "string" ? content : JSON.stringify(content, null, 2) });
const withApproach = (changes: Json): Json => ({ recommended_approach: { ...(validPart("x")["recommended_approach"] as Json), ...changes } });

// One merged row as json.dumps writes it: the finding's own fields, then the cluster's.
const mergedRow = (id: string, file: string, line: number): string =>
  `{"finding_id": "${id}", "file": "${file}", "line": ${line}, "cluster_id": "CLU-001", "cluster_label": "Shared defaults", "analyzed_at": "2026-04-15T00:00:00+00:00", ` +
  '"cluster_narrative": {"root_cause": "duplication", "systemic_pattern": "repeated wrapper defaults", "business_impact": "clients drift", "why_it_exists": "missing shared constants"}, ' +
  '"recommended_approach": {"strategy": "extract_and_replace", "description": "Move shared defaults into a single module.", "fix_order": ["DRY-001", "DRY-002"], "fix_blast_radius_files": 3, ' +
  '"risk_assessment": "Moderate risk if callers depend on local overrides.", "validation_steps": ["Run byakugan merge tests", "Rebuild affected generators"]}}';

interface InvalidCase {
  name: string;
  content: string | Json;
}

describe("impactOutputStatus", () => {
  it("tracks completed and missing clusters", () => {
    const project = projectFiles({ ...clustersFile("CLU-001", "CLU-002"), ...partFile("CLU-001") });

    const status = impactOutputStatus(project);

    expect(status).toEqual({
      parts_dir: join(project, PARTS),
      expected_clusters: ["CLU-001", "CLU-002"],
      completed_clusters: ["CLU-001"],
      missing_clusters: ["CLU-002"],
      invalid_parts: [],
      complete: false,
      merge_needed: false,
    });
  });

  it.each<InvalidCase>([
    { name: "only a cluster id", content: { cluster_id: "CLU-001" } },
    { name: "an empty file", content: "" },
    { name: "a JSON array", content: "[1]" },
    { name: "two JSON lines", content: '{"a":1}\n{"b":2}\n' },
    { name: "a cluster id that is another cluster's", content: validPart("CLU-002") },
    { name: "an empty cluster label", content: validPart("CLU-001", { cluster_label: " " }) },
    { name: "a missing analysis time", content: validPart("CLU-001", { analyzed_at: undefined }) },
    { name: "no source files read", content: validPart("CLU-001", { source_files_read: [], read_count: 0 }) },
    { name: "a read count below the files read", content: validPart("CLU-001", { read_count: 1 }) },
    { name: "no findings", content: validPart("CLU-001", { findings: [] }) },
    { name: "a finding on line 0", content: validPart("CLU-001", { findings: [{ finding_id: "DRY-001", file: "src/a.ts", line: 0 }] }) },
    { name: "a finding without an id", content: validPart("CLU-001", { findings: [{ file: "src/a.ts", line: 1 }] }) },
    { name: "an empty narrative field", content: validPart("CLU-001", { cluster_narrative: { root_cause: "", systemic_pattern: "x", business_impact: "x", why_it_exists: "x" } }) },
    { name: "an approach without validation steps", content: validPart("CLU-001", { recommended_approach: { ...(withApproach({})["recommended_approach"] as Json), validation_steps: undefined } }) },
    { name: "a strategy that is not offered", content: validPart("CLU-001", withApproach({ strategy: "rewrite_everything" })) },
    { name: "a fix order naming an unknown finding", content: validPart("CLU-001", withApproach({ fix_order: ["DRY-001", "DRY-999"] })) },
    { name: "a negative blast radius", content: validPart("CLU-001", withApproach({ fix_blast_radius_files: -1 })) },
    { name: "an empty risk assessment", content: validPart("CLU-001", withApproach({ risk_assessment: "" })) },
  ])("marks a part with $name invalid, not completed and not missing", ({ content }) => {
    const project = projectFiles({ ...clustersFile("CLU-001"), ...partFile("CLU-001", typeof content === "string" ? content : JSON.stringify(content)) });

    const status = impactOutputStatus(project);

    expect([status.completed_clusters, status.missing_clusters, status.invalid_parts, status.complete]).toEqual([[], [], ["CLU-001"], false]);
  });

  it("is not complete before clusters.json exists", () => {
    const status = impactOutputStatus(projectFiles({ ".keep": "" }));

    expect([status.expected_clusters, status.complete, status.merge_needed]).toEqual([[], false, false]);
  });
});

describe("mergeImpactAnalysisOutputs", () => {
  it("flattens each cluster's findings into jsonl rows carrying the cluster context, with a sentinel and a manifest", () => {
    const project = projectFiles({ ...clustersFile("CLU-001"), ...partFile("CLU-001") });

    const manifest = mergeImpactAnalysisOutputs(project);

    expect(readFileSync(join(project, FINAL), "utf8")).toBe(`${mergedRow("DRY-001", "src/a.ts", 10)}\n${mergedRow("DRY-002", "src/b.ts", 12)}\n`);
    expect(manifest).toMatchObject({
      expected_clusters: ["CLU-001"],
      completed_clusters: ["CLU-001"],
      source_files: ["deep/impact-analysis-parts/CLU-001.json"],
      merged_findings: 2,
      final_output: "deep/impact-analysis.jsonl",
    });
    expect(JSON.parse(readFileSync(join(project, `${FINAL}.done`), "utf8"))).toMatchObject({ lines: 2, auto_recovered: false });
    expect(JSON.parse(readFileSync(join(project, MANIFEST), "utf8"))).toEqual(manifest);
  });

  it("refuses while any part is missing or invalid", () => {
    const project = projectFiles({ ...clustersFile("CLU-001", "CLU-002"), ...partFile("CLU-001") });

    expect(() => mergeImpactAnalysisOutputs(project)).toThrow("impact analysis parts are incomplete");
  });

  it("a project with no clusters is complete: it merges to an empty output with a zero-line sentinel", () => {
    const project = projectFiles(clustersFile());
    expect(impactOutputStatus(project)).toMatchObject({ expected_clusters: [], complete: true, merge_needed: true });

    const manifest = mergeImpactAnalysisOutputs(project);

    expect(manifest).toMatchObject({ completed_clusters: [], merged_findings: 0 });
    expect(readFileSync(join(project, FINAL), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(project, `${FINAL}.done`), "utf8"))).toMatchObject({ lines: 0 });
    expect(impactOutputStatus(project)).toMatchObject({ complete: true, merge_needed: false });
  });

  it.each([
    { name: "a part newer than the merged output", change: (project: string) => utimesSync(join(project, `${PARTS}/CLU-001.json`), new Date(), new Date(Date.now() + 60_000)) },
    { name: "a manifest older than the merged output", change: (project: string) => utimesSync(join(project, MANIFEST), new Date(0), new Date(0)) },
    { name: "a deleted manifest", change: (project: string) => rmSync(join(project, MANIFEST)) },
    { name: "a manifest that disagrees with the parts", change: (project: string) => writeFileSync(join(project, MANIFEST), JSON.stringify({ ...(JSON.parse(readFileSync(join(project, MANIFEST), "utf8")) as Json), merged_findings: 99 })) },
  ])("asks for another merge after $name", ({ change }) => {
    const project = projectFiles({ ...clustersFile("CLU-001"), ...partFile("CLU-001") });
    mergeImpactAnalysisOutputs(project);
    expect(impactOutputStatus(project)).toMatchObject({ complete: true, merge_needed: false });

    change(project);

    expect(impactOutputStatus(project)).toMatchObject({ complete: true, merge_needed: true });
    expect(existsSync(join(project, FINAL))).toBe(true);
  });
});

const FINDINGS_FILE = "docs/audit/data/findings.jsonl";
const GRAPH_FILE = `${DEEP}/dependency-graph.json`;

interface StateCase {
  name: string;
  files: Record<string, string>;
  after?: (project: string) => void;
  state: string;
}

describe("getState", () => {
  it.each<StateCase>([
    { name: "no findings means rinnegan has not run", files: { ".keep": "" }, state: "NEEDS_RINNEGAN" },
    { name: "findings without a dependency graph", files: { [FINDINGS_FILE]: "{}\n" }, state: "NEEDS_DEPENDENCY_GRAPH" },
    { name: "a graph without clusters", files: { [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}" }, state: "NEEDS_CLUSTERING" },
    { name: "clusters without their impact parts", files: { [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...clustersFile("CLU-001") }, state: "NEEDS_IMPACT_ANALYSIS" },
    { name: "every part in but nothing merged", files: { [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...clustersFile("CLU-001"), ...partFile("CLU-001") }, state: "NEEDS_IMPACT_MERGE" },
    {
      name: "a merged output older than a part is merged again",
      files: { [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...clustersFile("CLU-001"), ...partFile("CLU-001") },
      after: (project) => {
        mergeImpactAnalysisOutputs(project);
        utimesSync(join(project, `${PARTS}/CLU-001.json`), new Date(), new Date(Date.now() + 60_000));
      },
      state: "NEEDS_IMPACT_MERGE",
    },
    {
      name: "a merged output with no deterministic report files needs rendering",
      files: { [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...clustersFile("CLU-001"), ...partFile("CLU-001") },
      after: (project) => void mergeImpactAnalysisOutputs(project),
      state: "NEEDS_REPORT_RENDER",
    },
    { name: "a project with no clusters is ready to merge an empty output", files: { [FINDINGS_FILE]: "", [GRAPH_FILE]: "{}", ...clustersFile() }, state: "NEEDS_IMPACT_MERGE" },
    {
      name: "a project with no clusters moves on to rendering once merged",
      files: { [FINDINGS_FILE]: "", [GRAPH_FILE]: "{}", ...clustersFile() },
      after: (project) => void mergeImpactAnalysisOutputs(project),
      state: "NEEDS_REPORT_RENDER",
    },
  ])("$name: $state", ({ files, after, state }) => {
    const project = projectFiles(files);
    after?.(project);

    expect(getState(project)).toBe(state);
  });
});

const SKILL_DIR = join(import.meta.dir, "..");
const dispatchLog = (project: string): Json[] =>
  readFileSync(join(project, "docs/audit/data/dispatch-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);

async function run(project: string): Promise<{ output: string; code: number }> {
  let output = "";
  const code = await runPipeline(project, (text) => (output += text));
  return { output, code };
}

const cluster = (id: string, overrides: Json = {}): Json => ({ id, type: "file", files: [`src/${id}.ts`], finding_count: 1, max_severity: "LOW", ...overrides });
const clustersJson = (clusters: Json[]): Record<string, string> => ({ [`${DEEP}/clusters.json`]: JSON.stringify({ clusters }) });
const actionBlock = (project: string): string[] => [
  `ACTION: Read ${SKILL_DIR}/impact-analysis-prompt.md then dispatch impact analysis agents.`,
  "  MODEL: sonnet",
  "  Each agent receives: cluster definition + dependency graph edges + findings JSONL",
  "  Dispatch up to 5 agents in parallel. Each handles one cluster JSON output file.",
  "  Large clusters (>10 findings) still get their own agent.",
  `  Write each result to: ${project}/${PARTS}/<CLUSTER_ID>.json`,
  "  Re-run this script after each batch. It auto-merges when all cluster files exist.",
];
const stateHeader = (project: string, state: string): string[] => [
  "",
  `STATE: ${state}`,
  `AUDIT_DIR: ${project}/docs/audit`,
  `DEEP_DIR: ${project}/${DEEP}`,
  `SKILL_DIR: ${SKILL_DIR}`,
  `PROJECT_DIR: ${project}`,
];

describe("runPipeline", () => {
  it("sends the operator to rinnegan when there are no findings", async () => {
    const project = projectFiles({ ".keep": "" });

    const { output, code } = await run(project);

    expect(code).toBe(0);
    expect(output).toBe(
      [
        ...stateHeader(project, "NEEDS_RINNEGAN"),
        "",
        "ACTION: Run rinnegan first to produce findings.",
        `  Run: bun ${SKILL_DIR}/../rinnegan/scripts/run-pipeline.ts ${project}`,
        "  (Or invoke /rinnegan if running inside a coding agent.)",
        "  Repeat until PIPELINE_COMPLETE, then run this script again.",
        "",
      ].join("\n"),
    );
  });

  it("builds the graph and the clusters itself, then hands out the first impact-analysis request", async () => {
    const project = projectFiles({
      "docs/audit/data/inventory.json": JSON.stringify({ stack: "typescript", files: ["src/a.ts"] }),
      [FINDINGS_FILE]: `${JSON.stringify({ id: "CLN-001", rule: "R09", severity: "LOW", category: "clean-code", file: "src/a.ts", line: 3, description: "print left" })}\n`,
      "src/a.ts": "export const a = 1;\n",
    });
    const real = realpathSync(project);

    const { output, code } = await run(project);

    expect(code).toBe(0);
    expect(output).toBe(
      [
        "AUTO: Building dependency graph...",
        "Built dependency graph: 1 nodes, 0 edges",
        `Output: ${real}/${GRAPH_FILE}`,
        "AUTO: Clustering findings...",
        "Clustered 1 findings into 1 clusters; annotated 1 findings",
        ...stateHeader(project, "NEEDS_IMPACT_ANALYSIS"),
        "",
        "CLUSTERS: 1",
        "WORK_ORDERS: 1 impact-analysis requests on disk",
        "",
        ...actionBlock(project),
        "  PENDING CLUSTERS: CLU-001",
        "",
        "  CLUSTER: id=CLU-001 type=file findings=1 severity=LOW",
        "    Files: src/a.ts",
        "",
      ].join("\n"),
    );
    expect(dispatchLog(project)).toMatchObject([{ task: "impact_analysis", tokens: 30_000, model: "sonnet" }]);
    expect(existsSync(join(project, "docs/audit/data/work-orders/impact-analysis/CLU-001/request.json"))).toBe(true);
  });

  it("on re-entry reports what is on disk, what is invalid and what is still pending, and marks every cluster with a part file on disk complete in its work order", async () => {
    const project = projectFiles({
      [FINDINGS_FILE]: "{}\n",
      [GRAPH_FILE]: "{}",
      ...clustersJson([cluster("CLU-001"), cluster("CLU-002"), cluster("CLU-003")]),
      ...partFile("CLU-001"),
      ...partFile("CLU-002", { cluster_id: "CLU-002" }),
    });

    const { output, code } = await run(project);

    expect(code).toBe(0);
    expect(output).toBe(
      [
        ...stateHeader(project, "NEEDS_IMPACT_ANALYSIS"),
        "",
        "CLUSTERS: 3",
        "WORK_ORDERS: 3 impact-analysis requests on disk",
        "",
        ...actionBlock(project),
        "  Resumption: 1/3 cluster files already on disk.",
        "  INVALID PARTS: CLU-002",
        "  PENDING CLUSTERS: CLU-003",
        "",
        "  CLUSTER: id=CLU-001 type=file findings=1 severity=LOW",
        "    Files: src/CLU-001.ts",
        "  CLUSTER: id=CLU-002 type=file findings=1 severity=LOW",
        "    Files: src/CLU-002.ts",
        "  CLUSTER: id=CLU-003 type=file findings=1 severity=LOW",
        "    Files: src/CLU-003.ts",
        "",
      ].join("\n"),
    );
    const orders = join(project, "docs/audit/data/work-orders/impact-analysis");
    const stateOf = (id: string): unknown => (JSON.parse(readFileSync(join(orders, id, "status.json"), "utf8")) as Json)["state"];
    expect(["CLU-001", "CLU-002", "CLU-003"].map(stateOf)).toEqual(["complete", "complete", "pending"]);
  });

  it("lists at most twenty clusters and ten pending ones, and budgets dispatch tokens by cluster count", async () => {
    const ids = Array.from({ length: 22 }, (_, index) => `CLU-${String(index + 1).padStart(3, "0")}`);
    const project = projectFiles({ [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...clustersJson(ids.map((id) => cluster(id, { files: ["a", "b", "c", "d", "e", "f", "g"] }))) });

    const { output } = await run(project);

    expect(output).toContain(`  PENDING CLUSTERS: ${ids.slice(0, 10).join(", ")}\n`);
    expect(output).toContain("  CLUSTER: id=CLU-020 type=file");
    expect(output).not.toContain("id=CLU-021");
    expect(output).toContain("    Files: a, b, c, d, e\n");
    expect(output).toEndWith("  ... and 2 more clusters\n");
    expect(dispatchLog(project)).toMatchObject([{ tokens: 150_000 }]);
  });

  it("stops with the script's own error when the dependency graph cannot be built", async () => {
    const project = projectFiles({ [FINDINGS_FILE]: "{}\n" });

    const { output, code } = await run(project);

    expect(code).toBe(1);
    expect(output).toBe(`AUTO: Building dependency graph...\nSCRIPT_ERROR: ERROR: inventory.json not found at ${realpathSync(project)}/docs/audit/data/inventory.json\n`);
  });
});

describe("runPipeline merge and render steps", () => {
  it.each([
    { name: "every part in: merges them, then renders and stops at the publication contract", files: { ...clustersFile("CLU-001"), ...partFile("CLU-001") }, merged: "2 findings from 1 clusters" },
    { name: "no clusters at all: merges an empty output, then renders and stops at the publication contract", files: clustersFile(), merged: "0 findings from 0 clusters" },
  ])("$name", async ({ files, merged }) => {
    const project = projectFiles({ [FINDINGS_FILE]: "{}\n", [GRAPH_FILE]: "{}", ...files });

    const { output, code } = await run(project);

    expect(code).toBe(1);
    expect(output.split("\n").slice(0, 4)).toEqual([
      "AUTO: Merging impact-analysis parts...",
      `AUTO: Wrote impact-analysis.jsonl (${merged})`,
      "AUTO: Rendering deterministic deep-analysis bundle...",
      "ERROR: byakugan publication contract is invalid",
    ]);
    expect(output).toMatch(/\n {2}- \S/);
    expect(existsSync(join(project, FINAL))).toBe(true);
    expect(existsSync(join(project, `${DEEP}/executive-brief.md`))).toBe(true);
  });
});

const PIPELINE_CLI = join(SKILL_DIR, "scripts", "run-pipeline.ts");

describe("byakugan run-pipeline CLI", () => {
  it("prints its usage without a project directory", () => {
    const result = Bun.spawnSync([process.execPath, PIPELINE_CLI], { stdout: "pipe", stderr: "pipe" });

    expect([result.exitCode, result.stdout.toString()]).toEqual([1, "Usage: run-pipeline.ts <project_dir>\n"]);
  });

  it("runs the graph and the clustering on the running bun, not one found on PATH", () => {
    const fakeBin = projectFiles({ bun: "#!/bin/sh\nexit 97\n" });
    chmodSync(join(fakeBin, "bun"), 0o755);
    const project = projectFiles({
      "docs/audit/data/inventory.json": JSON.stringify({ stack: "python", files: ["app/main.py"] }),
      [FINDINGS_FILE]: `${JSON.stringify({ id: "CLN-001", rule: "R09", severity: "LOW", category: "clean-code", file: "app/main.py", line: 3, description: "print left in production code" })}\n`,
    });

    const result = Bun.spawnSync([process.execPath, PIPELINE_CLI, project], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, `${DEEP}/clusters.json`))).toBe(true);
  });
});

const MERGE_CLI = join(SKILL_DIR, "scripts", "merge_impact_analysis.ts");

describe("merge_impact_analysis CLI", () => {
  it.each([
    { name: "merges complete parts and says how many findings and clusters", files: { ...clustersFile("CLU-001"), ...partFile("CLU-001") }, status: 0, stdout: "IMPACT_MERGED: 2 findings from 1 clusters\n" },
    { name: "refuses incomplete parts with the counts", files: { ...clustersFile("CLU-001", "CLU-002", "CLU-003"), ...partFile("CLU-001"), ...partFile("CLU-002", "{}") }, status: 1, stdout: "IMPACT_PARTS_INCOMPLETE\ncompleted=1 missing=1 invalid=1\n" },
  ])("$name", ({ files, status, stdout }) => {
    const project = projectFiles(files);

    const result = Bun.spawnSync([process.execPath, MERGE_CLI, project], { stdout: "pipe", stderr: "pipe" });

    expect([result.exitCode, result.stdout.toString()]).toEqual([status, stdout]);
  });

  it("prints its usage without a project directory", () => {
    const result = Bun.spawnSync([process.execPath, MERGE_CLI], { stdout: "pipe", stderr: "pipe" });

    expect([result.exitCode, result.stdout.toString()]).toEqual([1, "Usage: merge_impact_analysis.ts <project_dir>\n"]);
  });
});
