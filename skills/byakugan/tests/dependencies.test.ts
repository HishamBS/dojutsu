import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { buildGraphTypescript } from "@byakugan/build_dependency_graph.ts";
import { clusterFindings } from "@byakugan/cluster_findings.ts";

type Edge = { from: string; to: string; imports: string[] };

interface ResolutionCase {
  name: string;
  files: Record<string, string>;
  edges: Edge[];
  reverse?: Record<string, string[]>;
}

const TSCONFIG_WITH_ALIAS = `{
  // comments are legal in tsconfig
  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["./src/lib/*"] } }
}`;

describe("buildGraphTypescript", () => {
  it.each<ResolutionCase>([
    {
      name: "named, default and namespace imports keep the order named, default, other",
      files: {
        "src/index.ts": "import { a, b as c } from './lib/value';\nimport Def from './lib/def';\nimport * as ns from './lib/ns';\n",
        "src/lib/value.ts": "",
        "src/lib/def.ts": "",
        "src/lib/ns.ts": "",
      },
      edges: [
        { from: "src/index.ts", to: "src/lib/value.ts", imports: ["a", "b"] },
        { from: "src/index.ts", to: "src/lib/def.ts", imports: ["Def"] },
        { from: "src/index.ts", to: "src/lib/ns.ts", imports: [] },
      ],
    },
    {
      name: "side-effect, require, dynamic and re-export forms are edges",
      files: {
        "src/index.ts": "import './side';\nconst r = require('./req');\nconst d = import('./dyn');\nexport * from './all';\nexport { z } from './named';\n",
        "src/side.ts": "",
        "src/req.js": "",
        "src/dyn.jsx": "",
        "src/all.ts": "",
        "src/named.ts": "",
      },
      edges: [
        { from: "src/index.ts", to: "src/named.ts", imports: ["z"] },
        { from: "src/index.ts", to: "src/side.ts", imports: [] },
        { from: "src/index.ts", to: "src/req.js", imports: [] },
        { from: "src/index.ts", to: "src/dyn.jsx", imports: [] },
        { from: "src/index.ts", to: "src/all.ts", imports: [] },
      ],
    },
    {
      name: "aliases, directory index and .tsx resolve; externals, self imports and repeats do not",
      files: {
        "tsconfig.json": TSCONFIG_WITH_ALIAS,
        "src/index.ts":
          "import { v } from '@lib/value';\nimport l from './lib';\nimport Button from './ui/Button';\nimport _ from 'lodash';\nconst again = require('./lib/value');\n",
        "src/lib/value.ts": "",
        "src/lib/index.ts": "",
        "src/ui/Button.tsx": "",
        "src/self.ts": "import { me } from './self';\n",
      },
      edges: [
        { from: "src/index.ts", to: "src/lib/value.ts", imports: ["v"] },
        { from: "src/index.ts", to: "src/lib/index.ts", imports: ["l"] },
        { from: "src/index.ts", to: "src/ui/Button.tsx", imports: ["Button"] },
      ],
      reverse: {
        "src/lib/value.ts": ["src/index.ts"],
        "src/lib/index.ts": ["src/index.ts"],
        "src/ui/Button.tsx": ["src/index.ts"],
      },
    },
  ])("$name", ({ files, edges, reverse }) => {
    const sources = Object.keys(files).filter((path) => path !== "tsconfig.json");
    const graph = buildGraphTypescript(projectFiles(files), sources);

    expect(graph.edges).toEqual(edges);
    expect(graph.nodes).toEqual(sources.map((file) => ({ file })));
    expect(graph.reverse_map).toEqual(reverse ?? Object.fromEntries(edges.map((edge) => [edge.to, [edge.from]])));
    expect(graph.stats.total_edges).toBe(edges.length);
  });
});

const GRAPH_CLI = join(import.meta.dir, "..", "scripts", "build_dependency_graph.ts");

function runGraphCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, GRAPH_CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const inventory = (stack: string, files: string[]): string => JSON.stringify({ stack, files: files.map((path) => ({ path })) });

interface StackCase {
  name: string;
  stack: string;
  note?: string;
  warned: boolean;
  edges: number;
}

describe("build_dependency_graph CLI", () => {
  it.each<StackCase>([
    { name: "typescript stacks get real edges", stack: "TypeScript", warned: false, edges: 1 },
    { name: "python is listed as nodes with a note", stack: "python", note: "Dependency analysis not yet implemented for 'python'. Only file nodes are listed.", warned: false, edges: 0 },
    { name: "jvm stacks are listed as nodes with a note", stack: "kotlin", note: "Dependency analysis not yet implemented for 'kotlin'. Only file nodes are listed.", warned: false, edges: 0 },
    { name: "an unknown stack warns and says so in the graph", stack: "rust", note: "Dependency analysis not yet implemented for 'rust'. Only file nodes are listed.", warned: true, edges: 0 },
  ])("$name", ({ stack, note, warned, edges }) => {
    const sources = ["src/a.ts", "src/b.ts"];
    const project = projectFiles({
      "docs/audit/data/inventory.json": inventory(stack, sources),
      "src/a.ts": "import { b } from './b';\n",
      "src/b.ts": "export const b = 1;\n",
    });

    const { status, stdout } = runGraphCli([project]);

    expect(status).toBe(0);
    const graphPath = join(realpathSync(project), "docs", "audit", "deep", "dependency-graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { stack: string; note?: string; warning?: string; edges: unknown[] };
    expect([graph.stack, graph.note, graph.edges.length]).toEqual([stack === "TypeScript" ? "typescript" : stack, note, edges]);
    expect(graph.warning).toBe(warned ? `No dependency analysis available for '${stack}'. Impact analysis will be limited.` : undefined);
    const warning = `WARNING: Dependency graph not implemented for stack '${stack}'.\n  Byakugan will proceed with finding-level analysis only (no blast radius tracing).\n`;
    expect(stdout).toBe(`${warned ? warning : ""}Built dependency graph: 2 nodes, ${edges} edges\nOutput: ${graphPath}\n`);
  });
});

type Finding = Record<string, string | number>;

interface ClusterCase {
  name: string;
  findings: Finding[];
  graph?: object;
  clusters: object[];
  stats?: object;
}

const manyFindings = (count: number, make: (index: number) => Finding): Finding[] => Array.from({ length: count }, (_, index) => make(index));
const padded = (index: number): string => String(index).padStart(2, "0");

describe("clusterFindings", () => {
  it.each<ClusterCase>([
    {
      name: "a cross-cutting group and its file clusters merge into one cluster that keeps the file type",
      findings: [
        { id: "DRY-001", rule: "R01", description: "Shared default duplicated", file: "src/a.ts", cross_cutting_group: "3.1 Shared defaults" },
        { id: "DRY-002", rule: "R01", description: "Shared default duplicated", file: "src/b.ts", cross_cutting_group: "3.1 Shared defaults" },
      ],
      clusters: [
        {
          id: "CLU-001",
          type: "file",
          name: "Shared default duplicated",
          files: ["src/a.ts", "src/b.ts"],
          finding_ids: ["DRY-001", "DRY-002"],
          finding_count: 2,
          max_severity: "REVIEW",
          rules: ["R01"],
          root_pattern: "Shared default duplicated",
        },
      ],
      stats: { total_clusters: 1, total_findings_clustered: 2, avg_findings_per_cluster: 2, largest_cluster_size: 2, cross_cutting_clusters: 0, import_connected_clusters: 0, file_clusters: 1 },
    },
    {
      name: "files joined by an import edge cluster together, named after the worst finding",
      findings: [
        { id: "F-1", rule: "R07", severity: "HIGH", description: "any cast", file: "src/a.ts" },
        { id: "F-2", rule: "R14", severity: "LOW", description: "console log", file: "src/b.ts" },
      ],
      graph: { nodes: [{ file: "src/a.ts" }, { file: "src/b.ts" }], edges: [{ from: "src/a.ts", to: "src/b.ts", imports: [] }] },
      clusters: [{ type: "file", name: "any cast", files: ["src/a.ts", "src/b.ts"], max_severity: "HIGH", rules: ["R07", "R14"], finding_count: 2 }],
    },
    {
      name: "a mixed-rule cluster over twelve findings splits by rule",
      findings: manyFindings(14, (index) => ({
        id: `F-${padded(index)}`,
        rule: index < 7 ? "R01" : "R07",
        file: `src/${padded(index)}.ts`,
        line: index + 1,
        description: index < 7 ? "duplicate constant" : "double cast",
        cross_cutting_group: "G",
      })),
      clusters: [
        { id: "CLU-001", rules: ["R01"], finding_count: 7, name: "duplicate constant" },
        { id: "CLU-002", rules: ["R07"], finding_count: 7, name: "double cast" },
      ],
    },
    {
      name: "one pattern over twelve findings is chunked at twelve",
      findings: manyFindings(13, (index) => ({ id: `F-${padded(index)}`, rule: "R01", file: `src/${padded(index)}.ts`, line: 1, description: "same", search_pattern: "X" })),
      clusters: [{ finding_count: 12 }, { finding_count: 1 }],
    },
    {
      name: "an empty findings file still publishes an empty cluster set",
      findings: [],
      clusters: [],
      stats: { total_clusters: 0, total_findings_clustered: 0, avg_findings_per_cluster: 0, largest_cluster_size: 0, cross_cutting_clusters: 0, import_connected_clusters: 0, file_clusters: 0 },
    },
  ])("$name", ({ findings, graph, clusters, stats }) => {
    const files: Record<string, string> = { "docs/audit/data/findings.jsonl": findings.map((finding) => JSON.stringify(finding) + "\n").join("") };
    if (graph !== undefined) files["docs/audit/deep/dependency-graph.json"] = JSON.stringify(graph);
    const project = projectFiles(files);

    const result = clusterFindings(project);

    expect(result.clusters).toMatchObject(clusters);
    expect(result.clusters).toHaveLength(clusters.length);
    if (stats !== undefined) expect<unknown>(result.stats).toEqual(stats);
    const published = JSON.parse(readFileSync(join(project, "docs", "audit", "deep", "clusters.json"), "utf8")) as { clusters: unknown[]; stats: unknown };
    expect([published.clusters, published.stats]).toEqual([result.clusters, result.stats]);
    const clusterOf = new Map(result.clusters.flatMap((cluster) => cluster.finding_ids.map((id) => [id, cluster.id] as const)));
    const rows = readFileSync(join(project, "docs", "audit", "data", "findings.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; cluster_id?: string });
    expect<unknown>(rows.map((row) => [row.id, row.cluster_id])).toEqual(findings.map((finding) => [finding["id"], clusterOf.get(String(finding["id"]))]));
  });
});

const CLUSTER_CLI = join(import.meta.dir, "..", "scripts", "cluster_findings.ts");

interface ClusterCliCase {
  name: string;
  findings: string | undefined;
  stdout: (project: string) => string;
  published: boolean;
  firstRow?: string;
}

const noGraphWarning = (project: string): string => `WARNING: ${project}/docs/audit/deep/dependency-graph.json not found, skipping import clusters\n`;
const TWO_SHARED = [
  { id: "DRY-001", rule: "R01", description: "Shared default duplicated", file: "src/a.ts", cross_cutting_group: "3.1 Shared defaults" },
  { id: "DRY-002", rule: "R01", description: "Shared default duplicated", file: "src/b.ts", cross_cutting_group: "3.1 Shared defaults" },
];

describe("cluster_findings CLI", () => {
  it.each<ClusterCliCase>([
    {
      name: "reports the clustered and annotated counts and rewrites findings in json.dumps form",
      findings: TWO_SHARED.map((finding) => JSON.stringify(finding) + "\n").join(""),
      stdout: (project) => `${noGraphWarning(project)}Clustered 2 findings into 1 clusters; annotated 2 findings\n`,
      published: true,
      firstRow: '{"id": "DRY-001", "rule": "R01", "description": "Shared default duplicated", "file": "src/a.ts", "cross_cutting_group": "3.1 Shared defaults", "cluster_id": "CLU-001"}',
    },
    { name: "an empty findings file reports zero and still publishes", findings: "", stdout: () => "Clustered 0 findings into 0 clusters\n", published: true },
    {
      name: "a missing findings file warns and publishes nothing",
      findings: undefined,
      stdout: (project) => `WARNING: ${project}/docs/audit/data/findings.jsonl not found, no findings to cluster\nClustered 0 findings into 0 clusters\n`,
      published: false,
    },
  ])("$name", ({ findings, stdout, published, firstRow }) => {
    const project = realpathSync(projectFiles(findings === undefined ? { ".keep": "" } : { "docs/audit/data/findings.jsonl": findings }));

    const result = Bun.spawnSync([process.execPath, CLUSTER_CLI, project], { stdout: "pipe", stderr: "pipe" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(stdout(project));
    expect(existsSync(join(project, "docs", "audit", "deep", "clusters.json"))).toBe(published);
    if (firstRow !== undefined) expect(readFileSync(join(project, "docs", "audit", "data", "findings.jsonl"), "utf8").split("\n")[0]).toBe(firstRow);
  });
});
