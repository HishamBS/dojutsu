#!/usr/bin/env bun
// Rinnegan pipeline state machine. Run repeatedly: each run checks the disk state, advances the
// deterministic steps and writes ONE action for the LLM.
// Usage: run-pipeline.ts <project_dir> [--audit-only]
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { usageError } from "@quality/cli.ts";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { pyRound } from "@quality/py-round.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";
import type { ScanBatch } from "@quality/types.ts";
import { logDispatch } from "@dojutsu/dojutsu_state.ts";
import { writeEnrichmentWorkOrders, writeScanWorkOrders } from "@dojutsu/work_orders.ts";
import { aggregate } from "@rinnegan/aggregate_findings.ts";
import { renderBundle } from "@rinnegan/bundle_renderer.ts";
import { writeStats } from "@rinnegan/compute_audit_stats.ts";
import { DojutsuConfig, PROMPT_OVERHEAD_TOKENS, TOKENS_PER_LOC, TOOL_OVERHEAD_PER_FILE } from "@rinnegan/dojutsu_config.ts";
import { collapseFindingFamilies } from "@rinnegan/finding_families.ts";
import { applyPartialScan, unscannedFiles } from "@rinnegan/handle_partial_scan.ts";
import { normalizeFindingsFile } from "@rinnegan/normalize_categories.ts";
import { isOutputComplete, validateEnrichmentCompleteness } from "@rinnegan/output_validator.ts";
import { MAX_PHASE, MIN_PHASE } from "@rinnegan/phase-contract.ts";
import { writeHealthReport } from "@rinnegan/pipeline_health.ts";
import { canonicalPhaseDocRelPath, generatePhaseDocs, generateReportManifest, validatePublicationContract } from "@rinnegan/report_contract.ts";
import { pyFloat } from "@rinnegan/report-renderers/model.ts";
import type { ToolResult } from "@rinnegan/tool_runner.ts";
import { detectTools, runToolSafe } from "@rinnegan/tool_runner.ts";
import { loadInventoryFiles, validateScannerFile } from "@rinnegan/validate_scanner_output.ts";
import { auditOnlyMarkerPath, evaluateQualityGateFromAudit, generateDagAndConfig, isAuditOnly, validateNullFixCoverage } from "@rinnegan/run_pipeline_lib.ts";

const SKILL_DIR = dirname(import.meta.dir);
const SCRIPTS_DIR = import.meta.dir;
const PROG = "run-pipeline.ts";
const USAGE = `usage: ${PROG} [-h] [--audit-only] project_dir`;

const MAX_BATCH_RETRIES = 2;
const DISPATCHED_BATCHES = 5;
const ENRICH_TOKENS_PER_FINDING = 200;
const ENRICH_TOKENS_BASE = 5000;
const DEFAULT_STACK = "typescript";
const PERCENT = 100;
const MIN_FILE_COUNT = 1;

type Out = (text: string) => void;
type Json = Record<string, unknown>;
type PipelineBatch = ScanBatch & { retries?: number };
type PipelinePlan = { total_batches: number; completed: number; batches: PipelineBatch[] };

export type PipelineOptions = { auditOnly?: boolean; out?: Out };

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();
const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();
const say = (out: Out, text = ""): void => out(`${text}\n`);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// What a shell glob over `dir` matches: visible names the pattern accepts, in name order.
function globFiles(dir: string, pattern: RegExp): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name) && !name.startsWith("."))
    .sort()
    .map((name) => join(dir, name));
}

const JSONL_FILES = /\.jsonl$/;
const MARKDOWN_FILES = /\.md$/;
const PHASE_TASK_FILES = /^phase-.*-tasks\.json$/;

function readRecord(path: string): Json {
  const parsed: unknown = JSON.parse(readTextStrict(path));
  if (!isRecord(parsed)) throw new TypeError(`${path}: expected a JSON object`);
  return parsed;
}

function readJsonlRecords(path: string): Json[] {
  const rows: Json[] = [];
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const row: unknown = JSON.parse(stripped);
    if (!isRecord(row)) throw new TypeError(`${path}: a row is not a JSON object`);
    rows.push(row);
  }
  return rows;
}

const lineCountOf = (path: string): number => (isFile(path) ? universalLines(readTextStrict(path)).length : 0);

function isBatch(value: unknown): value is PipelineBatch {
  return (
    isRecord(value) &&
    typeof value["id"] === "number" &&
    typeof value["layer"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["output_file"] === "string" &&
    typeof value["finding_count"] === "number" &&
    (value["retries"] === undefined || typeof value["retries"] === "number") &&
    Array.isArray(value["files"]) &&
    value["files"].every((file) => typeof file === "string")
  );
}

function readPlan(path: string): PipelinePlan {
  const plan = readRecord(path);
  const batches = plan["batches"];
  if (typeof plan["total_batches"] !== "number" || typeof plan["completed"] !== "number" || !Array.isArray(batches) || !batches.every(isBatch)) {
    throw new TypeError(`${path}: not a scan plan`);
  }
  return { ...plan, total_batches: plan["total_batches"], completed: plan["completed"], batches };
}

function numberField(record: Json, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new TypeError(`${where}: ${key} must be a number`);
  return value;
}

// `x:.1f`: the nearest tenth, an exact tie going to the even digit.
function fixedTenth(value: number): string {
  return Math.abs(pyRound(value, 1)).toFixed(1);
}

// Fixed per-run state: where the audit lives and whether enrichment is skipped.
type Run = { projectDir: string; auditDir: string; auditOnly: boolean; out: Out };

const dataFile = (run: Run, name: string): string => join(run.auditDir, "data", name);
const hasAuditFile = (run: Run, relPath: string): boolean => isFile(join(run.auditDir, relPath));

// Run a deterministic sibling script on this runtime and print what it said.
function runScript(run: Run, name: string, args: readonly string[]): number {
  const result = Bun.spawnSync([process.execPath, join(SCRIPTS_DIR, name), ...args], { stdout: "pipe", stderr: "pipe" });
  say(run.out, pyStrip(result.stdout.toString()));
  const stderr = pyStrip(result.stderr.toString());
  if (result.exitCode !== 0 && stderr !== "") say(run.out, `SCRIPT_ERROR: ${stderr}`);
  return result.exitCode ?? 1;
}

// The pipeline state the artifacts on disk add up to.
function getState(run: Run): string {
  // Quality gates come first: the pre-commit framework or a Husky hook.
  const preCommit = join(run.projectDir, ".pre-commit-config.yaml");
  const huskyHook = join(run.projectDir, ".husky", "pre-commit");
  if (!(existsSync(preCommit) || existsSync(huskyHook))) return "NEEDS_QUALITY_GATES";
  if (!hasAuditFile(run, "data/inventory.json")) return "NEEDS_INVENTORY";
  if (!hasAuditFile(run, "data/scan-plan.json")) return "NEEDS_SCAN_PLAN";
  const plan = readPlan(dataFile(run, "scan-plan.json"));
  if (plan.batches.some((batch) => batch.status === "pending")) return "NEEDS_SCANNING";
  const findingsPath = dataFile(run, "findings.jsonl");
  // aggregate writes findings.jsonl in one step and its sentinel last, so the sentinel is the
  // whole completeness check. No ratio against raw scanner lines: dedupe of overlapping
  // scanners legitimately removes most of them.
  if (!isOutputComplete(findingsPath)) return "NEEDS_AGGREGATION";
  // An audit-only run skips the enrichment stage and the null-fix gate that guards its output;
  // fix-mode runs keep both.
  if (!isAuditOnly(run.auditDir)) {
    const enrichedDir = dataFile(run, "enriched");
    if (globFiles(enrichedDir, JSONL_FILES).length === 0) return "NEEDS_ENRICHMENT";
    if (validateEnrichmentCompleteness(findingsPath, enrichedDir).incomplete.length > 0) return "NEEDS_ENRICHMENT";
    if (validateNullFixCoverage(run.auditDir).triggered) return "BLOCKED_NULL_FIX";
  }
  if (!hasAuditFile(run, "data/phase-dag.json")) return "NEEDS_PHASES";
  if (!hasAuditFile(run, "master-audit.md")) return "NEEDS_GENERATION";
  if (globFiles(join(run.auditDir, "layers"), MARKDOWN_FILES).length === 0) return "NEEDS_GENERATION";
  if (globFiles(join(run.auditDir, "data", "tasks"), PHASE_TASK_FILES).length === 0) return "NEEDS_PHASES";
  for (let phase = MIN_PHASE; phase <= MAX_PHASE; phase += 1) {
    if (!hasAuditFile(run, canonicalPhaseDocRelPath(phase))) return "NEEDS_GENERATION";
  }
  if (!hasAuditFile(run, "data/audit-stats.json") || !hasAuditFile(run, "data/report-manifest.json")) return "NEEDS_GENERATION";
  if (!validatePublicationContract(run.auditDir, "rinnegan").ok) return "NEEDS_GENERATION";
  return "COMPLETE";
}

async function scanWithTools(run: Run): Promise<void> {
  const { out } = run;
  const toolOutput = join(run.auditDir, "data", "scanner-output", "tool-scanner.jsonl");
  if (existsSync(toolOutput)) return;
  const inventory = readRecord(dataFile(run, "inventory.json"));
  const stackValue = inventory["stack"];
  if (stackValue !== undefined && typeof stackValue !== "string") throw new TypeError("inventory.json: stack must be a string");
  const stack = stackValue ?? DEFAULT_STACK;
  const tools = detectTools(stack, run.projectDir);
  if (tools.length === 0) {
    say(out, "\nAUTO: No linting tools detected on PATH (eslint, ruff, mypy, semgrep). Skipping tool scan.");
    return;
  }
  say(out, `\nAUTO: Running deterministic tool scanners: ${tools.join(", ")}`);
  const lines: string[] = [];
  const results: ToolResult[] = [];
  for (const tool of tools) {
    const result = await runToolSafe(tool, run.projectDir, stack);
    results.push(result);
    for (const finding of result.findings) lines.push(pyJsonDumps(finding));
    const detail = `${tool}: [${result.status.toUpperCase()}] ${result.findingCount} findings (${result.durationMs}ms)`;
    say(out, result.error === "" ? `  ${detail}` : `  ${detail} — ${result.error}`);
  }
  writeFileSync(toolOutput, lines.map((line) => `${line}\n`).join(""));
  writeHealthReport(run.auditDir, results);
  const succeeded = results.filter((result) => result.status === "success").length;
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  say(out, `Tool scan: ${succeeded}/${tools.length} succeeded, ${lines.length} findings, ${totalMs} ms total`);
}

async function autoAdvance(run: Run, startState: string): Promise<string> {
  let state = startState;
  if (state === "NEEDS_INVENTORY") {
    say(run.out, "AUTO: Creating inventory + directories...");
    runScript(run, "create-inventory.ts", [run.projectDir, run.auditDir]);
    state = getState(run);
  }
  if (state === "NEEDS_SCAN_PLAN") {
    say(run.out, "AUTO: Creating scan plan...");
    runScript(run, "create-scan-plan.ts", [run.auditDir]);
    const plan = readPlan(dataFile(run, "scan-plan.json"));
    say(run.out, `AUTO: Wrote ${writeScanWorkOrders(run.auditDir, plan)} scanner work orders`);
    // The exhaustive grep scanner finds every mechanical violation deterministically.
    say(run.out, "\nAUTO: Running exhaustive grep scanner...");
    runScript(run, "grep-scanner.ts", [run.projectDir, run.auditDir]);
    // Deterministic tool scanners: ESLint, Ruff, mypy, Semgrep, Checkstyle, tsc.
    await scanWithTools(run);
    state = getState(run);
  }
  return state;
}

function printHeader(run: Run, state: string): void {
  say(run.out, `\nSTATE: ${state}`);
  say(run.out, `AUDIT_DIR: ${run.auditDir}`);
  say(run.out, `SKILL_DIR: ${SKILL_DIR}`);
  say(run.out, `PROJECT_DIR: ${run.projectDir}`);
}

function reconcileScanning(run: Run, config: DojutsuConfig): void {
  const { out } = run;
  const planPath = dataFile(run, "scan-plan.json");
  const plan = readPlan(planPath);

  // A batch that completed on disk but whose status was not updated (a session ended between
  // the scanner's output and the plan write) is recovered. A SCAN_PARTIAL sentinel names the
  // files its scanner did not read; they go to a follow-up batch instead of being marked
  // complete with the rest.
  let autoRecovered = 0;
  for (const batch of [...plan.batches]) {
    if (batch.status !== "pending") continue;
    const outputPath = join(run.auditDir, batch.output_file);
    if (!isOutputComplete(outputPath)) continue;
    const unscanned = unscannedFiles(outputPath);
    if (unscanned.length > 0) {
      const scanned = batch.files.filter((file) => !unscanned.includes(file));
      const followup = applyPartialScan(plan, batch.id, scanned);
      if (followup !== null) {
        say(out, `SCAN_PARTIAL: batch ${batch.id} left ${followup.files.length} of ${batch.files.length} files unscanned; queued batch ${followup.id} for: ${followup.files.join(" ")}`);
      } else if (batch.status === "pending") {
        say(out, `SCAN_PARTIAL: batch ${batch.id} scanned none of its files; re-dispatching it (retry ${pyStr(batch.retries)})`);
      }
    } else {
      batch.status = "complete";
    }
    autoRecovered += 1;
  }
  if (autoRecovered > 0) {
    plan.completed = plan.batches.filter((batch) => batch.status === "complete").length;
    writeFileSync(planPath, dumpJson(plan));
    say(out, `AUTO_RECOVER: ${autoRecovered} batches had output on disk but were marked pending — recovered`);
  }

  // Circuit breaker: an over-retried batch is failed.
  for (const batch of plan.batches) {
    if ((batch.retries ?? 0) >= MAX_BATCH_RETRIES && batch.status === "pending") batch.status = "failed";
  }
  const failed = plan.batches.filter((batch) => batch.status === "failed");
  if (failed.length > 0) {
    writeFileSync(planPath, dumpJson(plan));
    say(out, `  CIRCUIT BREAKER: ${failed.length} batches exceeded ${MAX_BATCH_RETRIES} retries — marked as failed, skipping`);
  }

  say(out, `AUTO: Reconciled ${writeScanWorkOrders(run.auditDir, plan)} scanner work orders`);

  // Only non-failed pending batches are dispatched.
  const pending = plan.batches.filter((batch) => batch.status === "pending");
  const complete = plan.batches.filter((batch) => batch.status === "complete").length;
  if (pending.length === 0) {
    say(out, `  All remaining batches resolved (${complete} complete, ${failed.length} failed). Re-run to advance pipeline.`);
    return;
  }

  const inventory = readRecord(dataFile(run, "inventory.json"));
  const files = inventory["files"];
  const fileCount = Array.isArray(files) ? files.length : 0;
  say(out, `\nSCAN_PROGRESS: ${complete}/${plan.total_batches} complete, ${pending.length} pending, ${failed.length} failed`);
  say(out, `STACK: ${pyStr(inventory["stack"] ?? "unknown")}/${pyStr(inventory["framework"] ?? "unknown")}`);
  const avgLoc = Math.floor(numberField(inventory, "total_loc", "inventory.json") / Math.max(fileCount, MIN_FILE_COUNT));
  const scannerTier = config.tierFor("scanner");
  const dispatched = pending.slice(0, DISPATCHED_BATCHES);
  for (const batch of dispatched) {
    const tokens = PROMPT_OVERHEAD_TOKENS + batch.files.length * (avgLoc * TOKENS_PER_LOC + TOOL_OVERHEAD_PER_FILE);
    logDispatch(run.projectDir, `scanner_${batch.id}`, tokens, scannerTier);
  }

  say(out, `\nACTION: Read ${SKILL_DIR}/scanner-prompt.md then dispatch up to ${DISPATCHED_BATCHES} scanner Agents.`);
  say(out, `  MODEL: ${scannerTier}`);
  say(out, `  ENFORCE: pass ${config.enforceModelDirective("scanner")} to the Agent tool call (NOT the parent default)`);
  say(out, `  CONTEXT: ${config.contextWindowFor("scanner").toLocaleString("en-US")} tokens`);
  say(out, "Each scanner Agent prompt must include: scanner-prompt.md content + file list + stack + layer + output path.");
  say(out, "When the scanners finish, run this script again; batches whose output and .done sentinel are on disk are marked complete automatically.\n");
  for (const batch of dispatched) {
    say(out, `SCANNER_BATCH: id=${batch.id} layer=${batch.layer} output=${join(run.auditDir, batch.output_file)} files=${batch.files.length}`);
    say(out, `  FILES: ${batch.files.join(" ")}`);
  }
}

// Validate, normalize and aggregate the scanner output.
function aggregateScannerOutput(run: Run): void {
  const { out } = run;
  const scannerFiles = globFiles(join(run.auditDir, "data", "scanner-output"), JSONL_FILES);

  // Step 1: validation rejects invalid findings before normalization.
  const inventoryPath = dataFile(run, "inventory.json");
  const planPath = dataFile(run, "scan-plan.json");
  const inventoryFiles = isFile(inventoryPath) ? loadInventoryFiles(inventoryPath) : undefined;
  // LOC each scan batch covered, keyed by its output file, for the per-KLOC density check.
  const batchLocByOutput = new Map<string, number>();
  if (isFile(inventoryPath) && isFile(planPath)) {
    const locByPath = new Map<string, number>();
    const inventoryRows = readRecord(inventoryPath)["files"];
    for (const row of Array.isArray(inventoryRows) ? inventoryRows : []) {
      if (!isRecord(row) || !("path" in row)) continue;
      const loc = row["loc"] ?? 0;
      if (typeof loc !== "number") throw new TypeError("inventory.json: a file's loc must be a number");
      locByPath.set(pyStr(row["path"]), Math.trunc(loc));
    }
    for (const batch of readPlan(planPath).batches) {
      batchLocByOutput.set(join(run.auditDir, batch.output_file), batch.files.reduce((sum, file) => sum + (locByPath.get(file) ?? 0), 0));
    }
  }
  let totalValid = 0;
  let totalRejected = 0;
  const warnings: string[] = [];
  for (const scannerFile of scannerFiles) {
    const result = validateScannerFile(scannerFile, inventoryFiles, batchLocByOutput.get(scannerFile));
    totalValid += result.valid;
    totalRejected += result.rejected;
    warnings.push(...result.warnings);
  }
  say(out, `AUTO: Scanner output validation: ${totalValid} valid, ${totalRejected} rejected.`);
  for (const warning of warnings) say(out, `  WARNING: ${warning}`);
  if (totalRejected > 0) say(out, "  Rejected findings written to *.rejected files in scanner-output/");

  // Step 2: normalization fixes LLM category drift in every scanner file.
  for (const scannerFile of scannerFiles) normalizeFindingsFile(scannerFile);
  say(out, "AUTO: Pre-aggregation normalization applied to all scanner output files.");
  const totalFindings = scannerFiles.reduce((sum, scannerFile) => sum + lineCountOf(scannerFile), 0);
  say(out, `\nSCANNER_OUTPUT: ${scannerFiles.length} files, ${totalFindings} total findings`);

  // Step 3: aggregate deterministically (dedupe, layers, IDs); no agent is dispatched.
  const aggregated = aggregate(run.auditDir);
  say(out, `AUTO: Aggregated ${totalFindings} scanner findings into ${aggregated} findings (${run.auditDir}/data/findings.jsonl, config.json)`);
  say(out, "\nACTION: Run this script again.");
}

function dispatchEnrichment(run: Run, config: DojutsuConfig): void {
  const { out } = run;
  const findings = readJsonlRecords(dataFile(run, "findings.jsonl"));
  const layers = new Map<string, number>();
  for (const finding of findings) {
    const layer = finding["layer"] === undefined ? "unknown" : pyStr(finding["layer"]);
    layers.set(layer, (layers.get(layer) ?? 0) + 1);
  }
  const enrichedDir = dataFile(run, "enriched");
  mkdirSync(enrichedDir, { recursive: true });

  // Layers already enriched in a previous session are not dispatched again.
  const { complete: completeLayers } = validateEnrichmentCompleteness(dataFile(run, "findings.jsonl"), enrichedDir);
  if (completeLayers.length > 0) {
    say(out, `AUTO_RECOVER: ${completeLayers.length} layers already enriched: ${[...completeLayers].sort().join(", ")}`);
  }
  const pendingLayers = [...layers].filter(([name]) => !completeLayers.includes(name));
  const mergeCommand = `bun ${SCRIPTS_DIR}/merge-enriched.ts ${run.auditDir}`;
  if (pendingLayers.length === 0) {
    say(out, `All ${layers.size} layers enriched. Run merge-enriched.ts then re-run pipeline.`);
    say(out, `  ${mergeCommand}`);
    return;
  }
  say(out, `AUTO: Wrote ${writeEnrichmentWorkOrders(run.auditDir, Object.fromEntries(pendingLayers))} enrichment work orders`);
  say(out, `\nFINDINGS: ${findings.length} across ${layers.size} layers (${completeLayers.length} already enriched)`);
  const enricherTier = config.tierFor("enricher");
  const byCount = [...pendingLayers].sort(([, a], [, b]) => b - a);
  for (const [name, count] of byCount) logDispatch(run.projectDir, `enricher_${name}`, count * ENRICH_TOKENS_PER_FINDING + ENRICH_TOKENS_BASE, enricherTier);

  say(out, `\nACTION: Read ${SKILL_DIR}/fix-enricher-instructions.md then dispatch 1 Fix Enricher Agent per layer.`);
  say(out, `  MODEL: ${enricherTier}`);
  say(out, `  ENFORCE: pass ${config.enforceModelDirective("enricher")} to the Agent tool call (NOT the parent default)`);
  say(out, "  NOTE: Enrichers must understand code well enough to write correct fixes.");
  for (const [name, count] of byCount) say(out, `  LAYER: ${name} (${count} findings) -> ${enrichedDir}/${name}.jsonl`);
  say(out, "\nAfter EACH enricher completes, its output + sentinel are safe on disk.");
  say(out, `When all enrichers are done, run: ${mergeCommand}`);
  say(out, "Then run this script again.");
}

function generatePhases(run: Run): number {
  const { out } = run;
  if (isAuditOnly(run.auditDir)) say(out, "\nAUDIT_ONLY: Enrichment stage skipped via --audit-only marker.");
  const families = collapseFindingFamilies(run.auditDir);
  say(out, `\nAUTO: Collapsed structural finding families (${families.families_created} families, ${families.subordinate_findings} subordinate findings)`);

  // The DAG and configuration are spec-fixed, never LLM-generated.
  const { dag, config } = generateDagAndConfig(run.auditDir, run.projectDir);
  say(out, `\nAUTO: Wrote phase-dag.json (${dag.edges.length} edges, ${dag.nodes.length} nodes)`);
  say(out, `AUTO: Wrote rasengan-config.json (${Object.keys(config).length} fields)`);
  const code = runScript(run, "create-phase-tasks.ts", [run.auditDir, run.projectDir]);
  if (code !== 0) return code;
  say(out, "AUTO: Wrote canonical phase task files");

  const gate = evaluateQualityGateFromAudit(run.auditDir);
  say(out, `AUTO: Wrote quality-gate.json (readiness=${pyFloat(gate.readiness_score)}%, verdict=${gate.overall})`);
  const { trend } = gate;
  if (trend !== null) {
    const delta = `${trend.delta < 0 ? "-" : "+"}${fixedTenth(trend.delta)}`;
    say(out, `  Trend: ${delta} (${trend.direction} from ${pyFloat(trend.previous)}%)`);
  }
  say(out, `\nFINDINGS: ${lineCountOf(dataFile(run, "findings.jsonl"))}`);
  say(out, "\nACTION: Phase DAG, config, and task files are now on disk.");
  say(out, "  Next run advances to report generation using the deterministic task files.");
  say(out, "Then run this script again.");
  return 0;
}

// One step of the report generation; a failure is reported and left to the publication
// validator on the next run.
function warnOnFailure(run: Run, what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    say(run.out, `WARNING: Could not ${what}: ${errorText(error)}`);
  }
}

function generateReports(run: Run): void {
  const { out } = run;
  const inventory = readRecord(dataFile(run, "inventory.json"));
  const findingsCount = lineCountOf(dataFile(run, "findings.jsonl"));

  // Every statistic is computed deterministically; generators use these, never their own counts.
  warnOnFailure(run, "pre-compute stats", () => say(out, `AUTO: Pre-computed audit statistics written to ${writeStats(run.auditDir)}`));
  warnOnFailure(run, "generate phase docs", () => say(out, `AUTO: Generated ${generatePhaseDocs(run.auditDir).length} canonical phase docs`));
  warnOnFailure(run, "write report-manifest.json", () => {
    generateReportManifest(run.auditDir);
    say(out, "AUTO: Wrote report-manifest.json");
  });
  warnOnFailure(run, "render deterministic audit bundle", () => {
    renderBundle(run.auditDir, "rinnegan", false);
    say(out, "AUTO: Rendered deterministic audit bundle");
  });

  const layers = inventory["layers"];
  if (!isRecord(layers)) throw new TypeError("inventory.json: layers must be an object");
  say(out, `\nFINDINGS: ${findingsCount}, LAYERS: ${Object.keys(layers).length}, LOC: ${pyStr(inventory["total_loc"])}`);
  say(out, "\nACTION: Deterministic audit bundle has been rendered from SSOT data.");
  say(out, "  Run this script again. The pipeline completes only if the publication validator accepts the bundle.");
}

function reportComplete(run: Run): void {
  const { out } = run;
  const findings = readJsonlRecords(dataFile(run, "findings.jsonl"));
  const findingsCount = lineCountOf(dataFile(run, "findings.jsonl"));
  const masterLines = lineCountOf(join(run.auditDir, "master-audit.md"));
  const layerLines = globFiles(join(run.auditDir, "layers"), MARKDOWN_FILES).reduce((sum, path) => sum + lineCountOf(path), 0);
  const hasFix = findings.filter((finding) => {
    const target = finding["target_code"];
    return (target !== undefined && target !== null) || isPyTruthy(finding["fix_plan"]);
  }).length;

  say(out, "\nPIPELINE_COMPLETE");
  say(out, `  Findings: ${findingsCount}`);
  say(out, `  Fix coverage: ${hasFix}/${findingsCount} (${Math.floor((hasFix * PERCENT) / Math.max(findingsCount, MIN_FILE_COUNT))}%)`);
  say(out, `  master-audit.md: ${masterLines} lines`);
  say(out, `  Layer docs: ${layerLines} lines`);
  say(out, "  Publication contract: valid");
  say(out, "\nACTION: Run verification scripts:");
  say(out, `  ${SKILL_DIR}/verify-output.sh ${run.auditDir}`);
  say(out, `  ${SKILL_DIR}/verify-snippets.sh ${run.auditDir} ${run.projectDir}`);
  say(out, `  ${SKILL_DIR}/verify-coverage.sh ${run.auditDir} ${run.projectDir}`);
}

function reportBlockedNullFix(run: Run): void {
  const { out } = run;
  const result = validateNullFixCoverage(run.auditDir);
  say(out, "\nSTATE: BLOCKED_NULL_FIX");
  say(out, `AUDIT_DIR: ${run.auditDir}`);
  say(out, `SKILL_DIR: ${SKILL_DIR}`);
  say(out, `PROJECT_DIR: ${run.projectDir}`);
  say(out, `\nBLOCKED: ${result.null_fix_count}/${result.non_review_count} non-REVIEW findings (${fixedTenth(result.percent)}%) have BOTH target_code and fix_plan null.`);
  say(out, "Per finding-schema.md this is invalid published data. Phase task generation is blocked.");
  say(out, "\nACTION: Re-dispatch enrichers, merge enriched output, then re-run /rinnegan.");
  say(out, `  Inspect with: grep -n '"target_code": null' ${run.auditDir}/data/findings.jsonl`);
}

// Main entry point: checks the state, advances the deterministic steps and emits the next action.
export async function runPipeline(projectDir: string, options: PipelineOptions = {}): Promise<number> {
  const run: Run = {
    projectDir,
    auditDir: join(projectDir, "docs", "audit"),
    auditOnly: options.auditOnly === true,
    out: options.out ?? ((text) => void process.stdout.write(text)),
  };
  if (run.auditOnly) {
    mkdirSync(join(run.auditDir, "data"), { recursive: true });
    writeFileSync(auditOnlyMarkerPath(run.auditDir), "1\n");
  }

  let state = getState(run);
  if (state === "NEEDS_QUALITY_GATES") {
    say(run.out, "\nSTATE: NEEDS_QUALITY_GATES");
    say(run.out, "\nQuality gate enforcement is required before auditing.");
    say(run.out, `No .pre-commit-config.yaml or .husky/pre-commit found in ${projectDir}`);
    say(run.out, "\nACTION: Run /setup-quality-gates on this project first.");
    say(run.out, "  This sets up pre-commit hooks, linting, formatting, and type-checking");
    say(run.out, "  for the detected stack. Once complete, re-run /rinnegan.");
    return 0;
  }
  if (state === "BLOCKED_NULL_FIX") {
    reportBlockedNullFix(run);
    return 0;
  }

  state = await autoAdvance(run, state);
  printHeader(run, state);

  const config = new DojutsuConfig();
  switch (state) {
    case "NEEDS_SCANNING":
      reconcileScanning(run, config);
      break;
    case "NEEDS_AGGREGATION":
      aggregateScannerOutput(run);
      break;
    case "NEEDS_ENRICHMENT":
      dispatchEnrichment(run, config);
      break;
    case "NEEDS_PHASES":
      return generatePhases(run);
    case "NEEDS_GENERATION":
      generateReports(run);
      break;
    case "COMPLETE":
      reportComplete(run);
      break;
  }
  return 0;
}

if (import.meta.main) {
  const positional: string[] = [];
  let auditOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "-h" || arg === "--help") {
      console.log(`${USAGE}\n\nRinnegan pipeline state machine.`);
      process.exit(0);
    } else if (arg === "--audit-only") {
      auditOnly = true;
    } else {
      positional.push(arg);
    }
  }
  const [projectDir, ...extra] = positional;
  if (projectDir === undefined) usageError(USAGE, PROG, "the following arguments are required: project_dir");
  if (extra.length > 0) usageError(USAGE, PROG, `unrecognized arguments: ${extra.join(" ")}`);
  process.exitCode = await runPipeline(projectDir, { auditOnly });
}
