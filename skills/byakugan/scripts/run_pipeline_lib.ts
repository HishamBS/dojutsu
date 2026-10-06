// Byakugan pipeline state machine - deep analysis engine. Builds the dependency graph, clusters
// findings, dispatches impact analysis agents, then renders and validates the narrative,
// scorecard and deployment plan.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyStr } from "@quality/py-format.ts";
import { logDispatch } from "@dojutsu/dojutsu_state.ts";
import { writeImpactWorkOrders } from "@dojutsu/work_orders.ts";
import { ImpactPartError, impactOutputStatus, mergeImpactAnalysisOutputs } from "@byakugan/merge_impact_analysis.ts";
import { renderBundle } from "@rinnegan/bundle_renderer.ts";
import { validatePublicationContract } from "@rinnegan/report_contract.ts";

const SKILL_DIR = dirname(import.meta.dir);
const IMPACT_TOKENS_PER_BATCH = 30_000;
const MAX_TOKEN_BATCHES = 5;
const CLUSTERS_PER_TOKEN_BATCH = 5;
const LISTED_CLUSTERS = 20;
const PENDING_CLUSTERS_SHOWN = 10;
const CLUSTER_FILES_SHOWN = 5;

type Out = (text: string) => void;
type Json = Record<string, unknown>;

const DETERMINISTIC_OUTPUTS: readonly string[] = ["narrative.md", "scorecard.md", "deployment-plan.md", "executive-brief.md"];

// The pipeline state the artifacts on disk add up to.
export function getState(projectDir: string): string {
  const auditDir = join(projectDir, "docs/audit");
  const deepDir = join(auditDir, "deep");
  const dataDir = join(auditDir, "data");

  // Prerequisite: rinnegan must be complete.
  if (!existsSync(join(dataDir, "findings.jsonl"))) return "NEEDS_RINNEGAN";
  // Step 1: dependency graph (deterministic).
  if (!existsSync(join(deepDir, "dependency-graph.json"))) return "NEEDS_DEPENDENCY_GRAPH";
  // Step 2: clustering (deterministic).
  if (!existsSync(join(deepDir, "clusters.json"))) return "NEEDS_CLUSTERING";

  // Step 3: impact analysis (LLM agents).
  const impact = impactOutputStatus(projectDir);
  if (impact.merge_needed) return "NEEDS_IMPACT_MERGE";
  if (!existsSync(join(deepDir, "impact-analysis.jsonl"))) return impact.complete ? "NEEDS_IMPACT_MERGE" : "NEEDS_IMPACT_ANALYSIS";

  // Step 4: deterministic publication bundle, compiled from the SSOT.
  if (!DETERMINISTIC_OUTPUTS.every((name) => existsSync(join(deepDir, name)))) return "NEEDS_REPORT_RENDER";
  if (!validatePublicationContract(auditDir, "byakugan").ok) return "NEEDS_REPORT_RENDER";
  return "COMPLETE";
}

function lineCount(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readTextStrict(path);
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function say(out: Out, text = ""): void {
  out(`${text}\n`);
}

// Runs a deterministic sibling script on this runtime and prints its output.
function runDeterministicScript(scriptName: string, projectDir: string, out: Out): number {
  const scriptPath = join(import.meta.dir, scriptName);
  if (!existsSync(scriptPath)) {
    say(out, `ERROR: Script not found: ${scriptPath}`);
    return 1;
  }
  const result = Bun.spawnSync([process.execPath, scriptPath, projectDir], { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  if (stdout !== "") say(out, stdout);
  if (result.exitCode !== 0) {
    say(out, `SCRIPT_ERROR: ${result.stderr.toString().trim()}`);
    return 1;
  }
  return 0;
}

function loadClusters(path: string): Json[] {
  const data: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(data) || !Array.isArray(data["clusters"])) throw new TypeError("clusters.json: expected an object with a clusters list");
  return (data["clusters"] as unknown[]).map((cluster) => {
    if (!isRecord(cluster)) throw new TypeError("clusters.json: a cluster is not an object");
    return cluster;
  });
}

function emitImpactAnalysis(projectDir: string, deepDir: string, out: Out): void {
  const auditDir = join(projectDir, "docs/audit");
  const status = impactOutputStatus(projectDir);
  mkdirSync(status.parts_dir, { recursive: true });
  const clusters = loadClusters(join(deepDir, "clusters.json"));
  const totalClusters = clusters.length;
  const workOrders = writeImpactWorkOrders(auditDir, clusters, new Set(status.completed_clusters));
  say(out);
  say(out, `CLUSTERS: ${totalClusters}`);
  say(out, `WORK_ORDERS: ${workOrders} impact-analysis requests on disk`);
  logDispatch(projectDir, "impact_analysis", IMPACT_TOKENS_PER_BATCH * Math.min(Math.floor(totalClusters / CLUSTERS_PER_TOKEN_BATCH) + 1, MAX_TOKEN_BATCHES), "sonnet");

  say(out);
  say(out, `ACTION: Read ${SKILL_DIR}/impact-analysis-prompt.md then dispatch impact analysis agents.`);
  say(out, "  MODEL: sonnet");
  say(out, "  Each agent receives: cluster definition + dependency graph edges + findings JSONL");
  say(out, "  Dispatch up to 5 agents in parallel. Each handles one cluster JSON output file.");
  say(out, "  Large clusters (>10 findings) still get their own agent.");
  say(out, `  Write each result to: ${status.parts_dir}/<CLUSTER_ID>.json`);
  say(out, "  Re-run this script after each batch. It auto-merges when all cluster files exist.");
  if (status.completed_clusters.length > 0) {
    say(out, `  Resumption: ${status.completed_clusters.length}/${status.expected_clusters.length} cluster files already on disk.`);
  }
  if (status.invalid_parts.length > 0) say(out, `  INVALID PARTS: ${status.invalid_parts.join(", ")}`);
  if (status.missing_clusters.length > 0) say(out, `  PENDING CLUSTERS: ${status.missing_clusters.slice(0, PENDING_CLUSTERS_SHOWN).join(", ")}`);
  say(out);

  for (const cluster of clusters.slice(0, LISTED_CLUSTERS)) {
    const files = Array.isArray(cluster["files"]) ? (cluster["files"] as unknown[]).map(pyStr) : [];
    say(out, `  CLUSTER: id=${pyStr(cluster["id"])} type=${pyStr(cluster["type"])} findings=${pyStr(cluster["finding_count"])} severity=${cluster["max_severity"] === undefined ? "UNKNOWN" : pyStr(cluster["max_severity"])}`);
    say(out, `    Files: ${files.slice(0, CLUSTER_FILES_SHOWN).join(", ")}`);
  }
  if (totalClusters > LISTED_CLUSTERS) say(out, `  ... and ${totalClusters - LISTED_CLUSTERS} more clusters`);
}

// Main entry point: checks the state, advances the deterministic steps and emits the next action.
export async function runPipeline(projectInput: string, out: Out = (text) => void process.stdout.write(text)): Promise<number> {
  const projectDir = resolve(projectInput);
  const auditDir = join(projectDir, "docs/audit");
  const deepDir = join(auditDir, "deep");
  let state = getState(projectDir);

  // Deterministic steps run inline, without an LLM.
  if (state === "NEEDS_DEPENDENCY_GRAPH") {
    say(out, "AUTO: Building dependency graph...");
    mkdirSync(deepDir, { recursive: true });
    const code = runDeterministicScript("build_dependency_graph.ts", projectDir, out);
    if (code !== 0) return code;
    state = getState(projectDir);
  }
  if (state === "NEEDS_CLUSTERING") {
    say(out, "AUTO: Clustering findings...");
    const code = runDeterministicScript("cluster_findings.ts", projectDir, out);
    if (code !== 0) return code;
    state = getState(projectDir);
  }
  if (state === "NEEDS_IMPACT_MERGE") {
    say(out, "AUTO: Merging impact-analysis parts...");
    try {
      const manifest = mergeImpactAnalysisOutputs(projectDir);
      say(out, `AUTO: Wrote impact-analysis.jsonl (${manifest.merged_findings} findings from ${manifest.completed_clusters.length} clusters)`);
    } catch (error) {
      if (!(error instanceof ImpactPartError)) throw error;
      say(out, `ERROR: ${error.message}`);
      return 1;
    }
    state = getState(projectDir);
  }
  if (state === "NEEDS_REPORT_RENDER") {
    say(out, "AUTO: Rendering deterministic deep-analysis bundle...");
    renderBundle(auditDir, "byakugan", false);
    const publication = validatePublicationContract(auditDir, "byakugan");
    if (!publication.ok) {
      say(out, "ERROR: byakugan publication contract is invalid");
      for (const error of publication.errors) say(out, `  - ${error}`);
      return 1;
    }
    say(out, "AUTO: Deterministic deep-analysis bundle validated.");
    state = getState(projectDir);
  }

  say(out);
  say(out, `STATE: ${state}`);
  say(out, `AUDIT_DIR: ${auditDir}`);
  say(out, `DEEP_DIR: ${deepDir}`);
  say(out, `SKILL_DIR: ${SKILL_DIR}`);
  say(out, `PROJECT_DIR: ${projectDir}`);

  if (state === "NEEDS_RINNEGAN") {
    say(out, "\nACTION: Run rinnegan first to produce findings.");
    say(out, `  Run: bun ${SKILL_DIR}/../rinnegan/scripts/run-pipeline.ts ${projectDir}`);
    say(out, "  (Or invoke /rinnegan if running inside a coding agent.)");
    say(out, "  Repeat until PIPELINE_COMPLETE, then run this script again.");
    return 0;
  }
  if (state === "NEEDS_IMPACT_ANALYSIS") {
    emitImpactAnalysis(projectDir, deepDir, out);
    return 0;
  }
  if (state === "COMPLETE") {
    say(out, "\nBYAKUGAN_COMPLETE");
    say(out, `  Dependency graph: ${deepDir}/dependency-graph.json`);
    say(out, `  Clusters: ${deepDir}/clusters.json`);
    say(out, `  Impact analyses: ${lineCount(join(deepDir, "impact-analysis.jsonl"))} entries`);
    say(out, `  Narrative: ${lineCount(join(deepDir, "narrative.md"))} lines`);
    say(out, `  Scorecard: ${deepDir}/scorecard.md`);
    say(out, `  Deployment plan: ${deepDir}/deployment-plan.md`);
  }
  return 0;
}
