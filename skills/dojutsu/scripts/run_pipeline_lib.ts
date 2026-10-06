// Dojutsu pipeline orchestrator - session-resilient state machine.
// Chains: rinnegan (detect) -> byakugan (analyze) -> [rasengan phase N -> sharingan phase N] x phases
// -> COMPLETE. All state on disk. Survives session changes. Agent-agnostic.
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyStr } from "@quality/py-format.ts";
import { get as configValue, getProgressPrefix } from "@dojutsu/dojutsu_config.ts";
import {
  DEFAULT_SESSION_TOKEN_BUDGET,
  IllegalTransitionError,
  appendProgress,
  checkBudget,
  clearDispatchLog,
  clearSentinel,
  ensureSentinel,
  getHeadSha,
  getTokensUsed,
  isEyeComplete,
  loadState,
  readProgress,
  resolveEyeScript,
  resolveSkillDir,
  saveState,
  tagGitCheckpoint,
  transition,
} from "@dojutsu/dojutsu_state.ts";
import type { DojutsuFlags, DojutsuState } from "@dojutsu/dojutsu_state.ts";

const SKILL_DIR = dirname(import.meta.dir);
const REVALIDATE_SCRIPT = join(dirname(SKILL_DIR), "rinnegan", "scripts", "revalidate-tasks.ts");
const MAX_FAILURES_PER_EYE = 2;
const MAX_ESCALATED_FAILURES = 2;
// The verdicts Sharingan's push policy lets through; the phase ACTION says the same.
const SHARINGAN_PASSING_VERDICTS: readonly string[] = ["CLEAR", "INFRA_DEGRADED", "INFRA_BLOCKED"];
const RATE_LIMIT_KEYWORDS: readonly string[] = [
  "rate limit", "rate_limit", "rate-limit", "limit exceeded", "too many requests", "429", "quota exceeded", "quota",
  "hit your limit", "resets", "throttl", "retry-after", "temporarily unavailable", "overloaded",
];
const RESUME_EXIT_REASONS: readonly (string | null | undefined)[] = ["rate_limited", "context_exhaustion", "manual_pause"];
const ERROR_SNIPPET_CHARS = 500;
const REVALIDATION_ERROR_CHARS = 200;
const REQUIRED_SKILLS: readonly string[] = ["rinnegan", "byakugan", "rasengan", "sharingan"];

const DEFAULT_FLAGS = { mode: "audit", phases: null, approval: "interactive", resume: false, status: false, report: false, clean: false } satisfies DojutsuFlags;
type Out = (text: string) => void;

// What rasengan writes to rasengan-state.json once no phase has a pending task.
const RASENGAN_STATUS_COMPLETE = "completed";
const BYAKUGAN_OUTPUTS: readonly string[] = [
  "dependency-graph.json",
  "clusters.json",
  "impact-analysis.jsonl",
  "narrative.md",
  "scorecard.md",
  "deployment-plan.md",
  "executive-brief.md",
];

const phaseStartKey = (phase: number | string): string => `phase-${phase}-start`;

function readJsonFile(path: string): unknown {
  return JSON.parse(readTextStrict(path));
}

// Whether the bundle verdict on disk is ok for the stage that has to be complete.
function bundleVerdictOk(verdictPath: string, requiredStage: string): boolean {
  if (!existsSync(verdictPath)) return false;
  let verdict: unknown;
  try {
    verdict = readJsonFile(verdictPath);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (!isRecord(verdict) || verdict["ok"] !== true) return false;
  const stageName = pyStr(verdict["stage"]);
  return requiredStage === "rinnegan" ? stageName === "rinnegan" || stageName === "byakugan" : stageName === requiredStage;
}

// A list of phase numbers in rasengan's state file; undefined when the key is absent or null.
function phaseList(state: Record<string, unknown>, key: string): number[] | undefined {
  const value = state[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((phase): phase is number => typeof phase === "number")) throw new TypeError(`rasengan-state.json: ${key} must be a list of phases`);
  return value;
}

// RASENGAN_PHASE_<first phase with tasks left that --phases selects>, else PIPELINE_COMPLETE.
function phaseToFix(rasenganState: Record<string, unknown>, state: DojutsuState): string {
  const selected = state.flags.phases;
  let pending = phaseList(rasenganState, "phases_pending");
  if (pending === undefined) {
    // Rasengan has not reported its pending phases (no run yet, or a state file from before it
    // did): only its current phase is known, and every phase before it is done.
    const currentPhase = rasenganState["current_phase"];
    if (currentPhase !== undefined && currentPhase !== null && typeof currentPhase !== "number") throw new TypeError("rasengan-state.json: current_phase must be a number");
    const first = currentPhase || 0;
    pending = selected === null || selected === undefined ? [first] : [...selected].sort((a, b) => a - b).filter((phase) => phase >= first);
  }
  const toFix = pending.filter((phase) => selected === null || selected === undefined || selected.includes(phase));
  return toFix.length > 0 ? `RASENGAN_PHASE_${toFix[0]}` : "PIPELINE_COMPLETE";
}

// The pipeline stage the audit artifacts on disk add up to.
export function detectStage(projectDir: string, state: DojutsuState): string {
  const auditDir = join(projectDir, "docs/audit");
  const deepDir = join(auditDir, "deep");
  const dataDir = join(auditDir, "data");
  const verdictPath = join(dataDir, "bundle-verdict.json");

  // 1. Rinnegan: master-audit.md is its final output.
  if (!existsSync(join(auditDir, "master-audit.md")) || !bundleVerdictOk(verdictPath, "rinnegan")) return "RINNEGAN_ACTIVE";

  // 2. Byakugan: the full analysis package must exist before the audit is complete.
  if (!BYAKUGAN_OUTPUTS.every((name) => existsSync(join(deepDir, name))) || !bundleVerdictOk(verdictPath, "byakugan")) return "BYAKUGAN_ACTIVE";

  // 3. Rasengan + Sharingan per-phase loop.
  const rasenganStateFile = join(dataDir, "rasengan-state.json");
  if (!existsSync(rasenganStateFile)) return phaseToFix({}, state);
  const rasenganState = readJsonFile(rasenganStateFile);
  if (!isRecord(rasenganState)) throw new TypeError("rasengan-state.json: expected an object");

  const completedPhases = phaseList(rasenganState, "phases_completed") ?? [];
  const verifiedPhases = state.verified_phases;
  const checkpoints = state.git_checkpoints;
  // Sharingan verifies the range of fixes dojutsu opened for a phase. A phase it never opened (no
  // tasks, or resolved by revalidation) has no range, so it is not verified; run_pipeline drops the
  // checkpoint of a phase that closed with no commit, for the same reason.
  const unverified = completedPhases.filter((phase) => !verifiedPhases.includes(phase) && phaseStartKey(phase) in checkpoints);
  if (unverified.length > 0) return `SHARINGAN_PHASE_${unverified[0]}`;
  if (rasenganState["status"] === RASENGAN_STATUS_COMPLETE) return "PIPELINE_COMPLETE";
  return phaseToFix(rasenganState, state);
}

// --- Output and process helpers ---

const grouped = (value: number): string => value.toLocaleString("en-US");
const phaseSuffix = (stage: string): string => stage.slice(stage.lastIndexOf("_") + 1);

function sessionTokenBudget(): number {
  let configured: unknown;
  try {
    configured = configValue("pipeline.session_token_budget");
  } catch {
    return DEFAULT_SESSION_TOKEN_BUDGET;
  }
  if (configured === undefined) return DEFAULT_SESSION_TOKEN_BUDGET;
  if (typeof configured !== "number") throw new TypeError("pipeline.session_token_budget: expected a number");
  return configured;
}

type Run = { code: number; stdout: string; stderr: string };

function runProcess(command: string[], cwd: string): Run {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function say(out: Out, text = ""): void {
  out(`${text}\n`);
}

// Revalidates pending tasks against live source code. Zero tokens.
function revalidateRemainingTasks(projectDir: string, out: Out, changedOnly = true): void {
  if (!existsSync(REVALIDATE_SCRIPT)) return;
  const command = [process.execPath, REVALIDATE_SCRIPT, projectDir, ...(changedOnly ? ["--changed-only"] : [])];
  const result = runProcess(command, projectDir);
  const prefix = getProgressPrefix();
  if (result.code !== 0) {
    say(out, `${prefix} WARNING: Task revalidation failed (exit ${result.code})`);
    if (result.stderr.trim() !== "") say(out, `${prefix}   ${Array.from(result.stderr.trim()).slice(0, REVALIDATION_ERROR_CHARS).join("")}`);
    return;
  }
  if (result.stdout.trim() !== "") for (const line of result.stdout.trim().split("\n")) say(out, `${prefix} ${line}`);
}

// Pauses the pipeline gracefully: saves state, logs, prints how to resume.
function pausePipeline(projectDir: string, state: DojutsuState, eye: string, reason: string, out: Out): number {
  const prefix = getProgressPrefix();
  const budget = sessionTokenBudget();
  const used = getTokensUsed(projectDir);
  say(out);
  say(out, `${prefix} === PIPELINE PAUSED ===`);
  say(out, `${prefix} Reason: ${reason}`);
  say(out, `${prefix} Tokens used this session: ${grouped(used)} / ${grouped(budget)}`);
  say(out, prefix);
  say(out, `${prefix} To resume: start a new session and type /dojutsu`);
  say(out, `${prefix} The pipeline picks up exactly where it left off.`);
  say(out);
  appendProgress(projectDir, { stage: state.stage, eye, summary: `Paused: ${reason} (${grouped(used)} tokens used)`, exitReason: "rate_limited" });
  saveState(projectDir, state);
  return 0;
}

// --- Phase verification by Sharingan ---

// The --base Sharingan verifies a phase from: the commit recorded when it began. detectStage
// sends only phases with that checkpoint to Sharingan.
function phaseBase(state: DojutsuState, phase: number): string {
  const base = state.git_checkpoints[phaseStartKey(phase)];
  if (base === undefined) throw new Error(`no start checkpoint recorded for phase ${phase}`);
  return base;
}

// True only when git reports no commit between the phase's start and HEAD.
function phaseRangeIsEmpty(projectDir: string, state: DojutsuState, phase: number): boolean {
  const result = runProcess(["git", "rev-list", "--count", `${phaseBase(state, phase)}..HEAD`], projectDir);
  return result.code === 0 && result.stdout.trim() === "0";
}

// sharingan/run.sh writes verdicts under the git top level of the project.
function sharinganVerdictDir(projectDir: string): string {
  const result = runProcess(["git", "rev-parse", "--show-toplevel"], projectDir);
  return join(result.code === 0 ? result.stdout.trim() : projectDir, ".sharingan");
}

// The verdict when Sharingan passed this phase's range at the current HEAD, else undefined.
function passingPhaseVerdict(projectDir: string, state: DojutsuState, phase: number): string | undefined {
  const head = getHeadSha(projectDir);
  const path = join(sharinganVerdictDir(projectDir), `${head}.verdict.json`);
  let verdict: unknown;
  try {
    verdict = readJsonFile(path);
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isRecord(verdict) || verdict["commit"] !== head || verdict["base"] !== phaseBase(state, phase)) return undefined;
  const status = verdict["verdict"];
  return typeof status === "string" && SHARINGAN_PASSING_VERDICTS.includes(status) ? status : undefined;
}

// Runs an eye's pipeline script (with eyeArgs after the project dir) and handles its output.
function delegateToEye(eye: string, projectDir: string, state: DojutsuState, out: Out, ...eyeArgs: string[]): number {
  const [ok, reason] = checkBudget(projectDir, sessionTokenBudget());
  if (!ok) return pausePipeline(projectDir, state, eye, reason, out);

  let eyeScript: string;
  try {
    eyeScript = resolveEyeScript(eye);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    say(out, `ERROR: ${error.message}`);
    say(out, `Install the ${eye} skill beside dojutsu in the same skills directory.`);
    return 1;
  }

  // The eye runs on this runtime: whatever bun is first on PATH may be an older one.
  const result = runProcess([process.execPath, eyeScript, projectDir, ...eyeArgs], projectDir);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  // Rate limits come first and are not retried. Only stderr is read: stdout carries ACTION text
  // that may mention "rate limit" in its instructions.
  const errorOutput = stderr.toLowerCase();
  if (RATE_LIMIT_KEYWORDS.some((keyword) => errorOutput.includes(keyword))) return pausePipeline(projectDir, state, eye, "Rate limited by provider", out);

  if (result.code !== 0 && stdout === "") {
    const failures = (state.failure_counts[eye] ?? 0) + 1;
    state.failure_counts[eye] = failures;
    saveState(projectDir, state);
    if (failures >= MAX_FAILURES_PER_EYE + MAX_ESCALATED_FAILURES) {
      say(out, `BLOCKED: ${eye} failed ${failures} times. Human review required.`);
      say(out, `  Last error: ${Array.from(stderr).slice(0, ERROR_SNIPPET_CHARS).join("")}`);
      return 1;
    }
    if (failures >= MAX_FAILURES_PER_EYE) say(out, `WARNING: ${eye} failed ${failures} times. Consider model escalation.`);
    say(out, `ERROR: ${eye} script failed (attempt ${failures}):`);
    say(out, stderr === "" ? "No error output" : Array.from(stderr).slice(0, ERROR_SNIPPET_CHARS).join(""));
    say(out, "\nACTION: Investigate and fix, then run this script again.");
    return 1;
  }

  if (isEyeComplete(stdout, eye)) {
    const checkpoint = getHeadSha(projectDir);
    tagGitCheckpoint(projectDir, `${eye}-complete`);
    appendProgress(projectDir, { stage: state.stage, eye, summary: `${eye} complete`, gitCheckpoint: checkpoint });
    state.failure_counts[eye] = 0;
    saveState(projectDir, state);
    say(out, `EYE_COMPLETE: ${eye}`);
    say(out, `  Git checkpoint: dojutsu/${eye}-complete (${checkpoint})`);
    say(out, "\nACTION: Run this script again to advance to the next eye.");
    return 0;
  }

  // The eye needs LLM action: pass it through with the dispatch-mode header.
  const prefix = getProgressPrefix();
  say(out, `${prefix} DISPATCH_MODE: native`);
  say(out, `${prefix} When ACTION says MODEL: use Agent(model="<MODEL>", prompt="...") for subagent dispatch`);
  say(out);
  say(out, stdout);
  if (stderr !== "") say(out, stderr);
  return 0;
}

// Tells the LLM to run full sharingan for a phase.
function emitSharinganAction(projectDir: string, state: DojutsuState, phase: number, out: Out): number {
  const taskFile = join(projectDir, "docs/audit/data", `tasks/phase-${phase}-tasks.json`);
  if (!existsSync(taskFile)) {
    say(out, `ERROR: Phase task file not found: ${taskFile}`);
    return 1;
  }
  const baseCommit = phaseBase(state, phase);
  say(out, `STAGE: SHARINGAN_PHASE_${phase}`);
  say(out, `SKILL_DIR: ${SKILL_DIR}`);
  say(out, `PROJECT_DIR: ${projectDir}`);
  say(out);
  say(out, `Phase ${phase} is complete. Verify it with Sharingan over the phase range.`);
  say(out);
  say(out, `ACTION: Run: ~/.coding-agent/sharingan/run.sh --base ${baseCommit}`);
  say(out, `  Phase requirements: ${taskFile}`);
  say(out, `  Verdict file: ${sharinganVerdictDir(projectDir)}/<HEAD sha>.verdict.json`);
  say(out);
  say(out, "  CLEAR or INFRA_* → run this script again");
  say(out, "  BLOCKED or PARTIAL → fix what the verdict names, commit, then run this script again");
  return 0;
}

const pyList = (values: readonly unknown[]): string => `[${values.map(String).join(", ")}]`;

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readTextStrict(path);
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function emitCompletionSummary(projectDir: string, state: DojutsuState, out: Out): number {
  const deepDir = join(projectDir, "docs/audit/deep");
  const findingsCount = countLines(join(projectDir, "docs/audit/data/findings.jsonl"));
  const verified = state.verified_phases;
  const selected = state.flags.phases;
  clearSentinel(projectDir);
  say(out, "PIPELINE_COMPLETE");
  say(out);
  say(out, `  Rinnegan: ${findingsCount} findings detected`);
  say(out, `  Byakugan: deep analysis in ${deepDir}/`);
  say(out, `  Rasengan: ${selected !== null && selected !== undefined && selected.length > 0 ? `phases ${pyList(selected)}` : "all phases"} fixed`);
  say(out, `  Sharingan: ${verified.length} phases verified (CLEAR or INFRA_*)`);
  say(out, `  Sessions used: ${state.session_count}`);
  say(out, `  Pipeline ID: ${state.pipeline_id}`);
  appendProgress(projectDir, {
    stage: "PIPELINE_COMPLETE",
    eye: "dojutsu",
    summary: `Pipeline complete: ${findingsCount} findings, ${verified.length} phases verified`,
    gitCheckpoint: getHeadSha(projectDir),
  });
  return 0;
}

// CLI flags win, then the flags saved in the state, then the defaults.
function resolveFlags(state: DojutsuState, cliFlags: Partial<DojutsuFlags> | null | undefined): DojutsuFlags {
  const saved = state.flags;
  const hasCli = cliFlags !== null && cliFlags !== undefined && Object.keys(cliFlags).length > 0;
  if (hasCli && cliFlags.resume) return { ...DEFAULT_FLAGS, ...saved, resume: true };
  if (hasCli) return { ...DEFAULT_FLAGS, ...cliFlags };
  if (Object.keys(saved).length > 0) return { ...DEFAULT_FLAGS, ...saved };
  return { ...DEFAULT_FLAGS };
}

function emitPhaseApproval(phase: number, verdict: string, out: Out): number {
  const prefix = getProgressPrefix();
  say(out);
  say(out, `${prefix} === PHASE ${phase} VERIFIED (${verdict}) ===`);
  say(out, `${prefix} To continue to next phase, run this script again.`);
  say(out, `${prefix} To stop here, do nothing.`);
  say(out, `${prefix} To switch to auto mode, run with --fix --auto`);
  say(out);
  return 0;
}

function emitAuditComplete(projectDir: string, out: Out): number {
  const auditDir = join(projectDir, "docs/audit");
  const deepDir = join(auditDir, "deep");
  const prefix = getProgressPrefix();
  const findingsCount = countLines(join(auditDir, "data", "findings.jsonl"));
  clearSentinel(projectDir);
  say(out);
  say(out, `${prefix} === AUDIT COMPLETE (read-only mode) ===`);
  say(out, prefix);
  say(out, `${prefix} Findings: ${findingsCount}`);
  say(out, `${prefix} Narrative: ${deepDir}/narrative.md`);
  say(out, `${prefix} Scorecard: ${deepDir}/scorecard.md`);
  say(out, `${prefix} Deployment plan: ${deepDir}/deployment-plan.md`);
  say(out, prefix);
  say(out, `${prefix} To proceed with fixes:`);
  say(out, `${prefix}   Run with --fix                    (interactive, approve per phase)`);
  say(out, `${prefix}   Run with --fix --phases 0,1,2     (fix selected phases only)`);
  say(out, `${prefix}   Run with --fix --auto             (fully autonomous)`);
  say(out);
  appendProgress(projectDir, { stage: "AUDIT_COMPLETE", eye: "dojutsu", summary: `Audit complete: ${findingsCount} findings. Fix mode not enabled.` });
  return 0;
}

function handleStatus(projectDir: string, out: Out): number {
  const prefix = getProgressPrefix();
  let state: DojutsuState;
  try {
    state = loadState(projectDir);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    say(out, `${prefix} No pipeline state found.`);
    return 0;
  }
  const flags = state.flags;
  say(out, `${prefix} Stage: ${state.stage}`);
  say(out, `${prefix} Mode: ${flags.mode}`);
  say(out, `${prefix} Verified phases: ${pyList(state.verified_phases)}`);
  say(out, `${prefix} Sessions: ${state.session_count}`);
  if (flags.phases !== null && flags.phases.length > 0) say(out, `${prefix} Phase filter: ${pyList(flags.phases)}`);
  return 0;
}

// Deletes docs/audit/ - only ever on the operator's explicit --clean request.
function handleClean(projectDir: string, out: Out): number {
  const prefix = getProgressPrefix();
  const auditDir = join(projectDir, "docs/audit");
  if (existsSync(auditDir)) {
    rmSync(auditDir, { recursive: true });
    say(out, `${prefix} Removed ${auditDir}/`);
  } else {
    say(out, `${prefix} No audit data found.`);
  }
  return 0;
}

function handleReport(projectDir: string, out: Out): number {
  say(out, `${getProgressPrefix()} To regenerate reports, delete existing files in ${join(projectDir, "docs/audit/deep")}/ then run audit.`);
  return 0;
}

// Main entry point: checks the state, delegates to an eye or emits the next action.
export async function runPipeline(projectInput: string, flags?: Partial<DojutsuFlags> | null, out: Out = (text) => void process.stdout.write(text)): Promise<number> {
  const projectDir = resolve(projectInput);

  // Informational commands change no state.
  if (flags?.status) return handleStatus(projectDir, out);
  if (flags?.report) return handleReport(projectDir, out);
  if (flags?.clean) return handleClean(projectDir, out);

  // Pre-flight: every skill the pipeline chains must be resolvable.
  const missingSkills = REQUIRED_SKILLS.filter((skill) => {
    try {
      resolveSkillDir(skill);
      return false;
    } catch (error) {
      if (error instanceof Error) return true;
      throw error;
    }
  });
  if (missingSkills.length > 0) {
    say(out, `ERROR: Missing skills: ${missingSkills.join(", ")}`);
    say(out, "  Install rinnegan, byakugan, rasengan and sharingan beside dojutsu in the same skills directory.");
    return 1;
  }

  const state = loadState(projectDir);
  ensureSentinel(projectDir);

  const effectiveFlags = resolveFlags(state, flags);
  state.flags = effectiveFlags;
  saveState(projectDir, state);

  // Startup revalidation: catch any code changes since the last run.
  if (state.stage.startsWith("RASENGAN_PHASE_") || state.stage.startsWith("SHARINGAN_PHASE_")) {
    say(out, `${getProgressPrefix()} Startup: revalidating pending tasks against live code...`);
    revalidateRemainingTasks(projectDir, out, false);
  }

  // Session resume: a rate limit, context exhaustion or manual pause ended the last one.
  const lastProgress = readProgress(projectDir, 1)[0];
  if (lastProgress !== undefined && RESUME_EXIT_REASONS.includes(lastProgress["exit_reason"] as string | null | undefined)) {
    const resumeReason = lastProgress["summary"] === undefined ? "unknown" : pyStr(lastProgress["summary"]);
    state.session_count += 1;
    clearDispatchLog(projectDir);
    appendProgress(projectDir, { stage: state.stage, eye: "dojutsu", summary: `Session ${state.session_count} started`, exitReason: null });
    const prefix = getProgressPrefix();
    say(out);
    say(out, `${prefix} === RESUMING PIPELINE (session ${state.session_count}) ===`);
    say(out, prefix);
    say(out, `${prefix} Previous session: ${resumeReason}`);
    say(out, `${prefix} Resuming from: ${state.stage}`);
    say(out, prefix);
    say(out, `${prefix} Continue with the ACTION below; the pipeline generates every artifact from disk state.`);
    say(out);
  }

  let detected = detectStage(projectDir, state);

  // Audit mode stops before rasengan.
  if (effectiveFlags.mode === "audit" && (detected.startsWith("RASENGAN_PHASE_") || detected.startsWith("SHARINGAN_PHASE_") || detected === "PIPELINE_COMPLETE")) {
    return emitAuditComplete(projectDir, out);
  }

  // A phase is verified by a passing Sharingan verdict for its own range, and by nothing else; the
  // stage it then advances to is detected from disk like any other.
  if (detected.startsWith("SHARINGAN_PHASE_")) {
    const phase = Number(phaseSuffix(detected));
    let verdict: string | undefined;
    if (phaseRangeIsEmpty(projectDir, state, phase)) {
      // Opened, then closed with no commit: rasengan found nothing left to fix, so there is no range
      // to verify. Dropping its start makes it a phase never opened, which detectStage leaves out of
      // Sharingan, and keeps it out once later phases commit.
      delete state.git_checkpoints[phaseStartKey(phase)];
      saveState(projectDir, state);
      say(out, `${getProgressPrefix()} Phase ${phase} closed with no commits: nothing for Sharingan to verify.`);
      detected = detectStage(projectDir, state);
    } else {
      verdict = passingPhaseVerdict(projectDir, state, phase);
    }
    if (verdict !== undefined) {
      state.verified_phases.push(phase);
      state.verified_phases.sort((a, b) => a - b);
      saveState(projectDir, state);
      const prefix = getProgressPrefix();
      say(out, `${prefix} Phase ${phase} verified by Sharingan (${verdict}).`);
      say(out, `${prefix} Revalidating remaining tasks after Phase ${phase} fixes...`);
      revalidateRemainingTasks(projectDir, out, true);
      if (effectiveFlags.approval === "interactive" && effectiveFlags.mode === "fix") return emitPhaseApproval(phase, verdict, out);
      detected = detectStage(projectDir, state);
    }
  }

  // A stage change is a transition; the start of a phase is recorded once the transition succeeded.
  if (detected !== state.stage) {
    try {
      transition(state, detected, projectDir);
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
      say(out, `ERROR: ${error.message}`);
      return 1;
    }
    if (detected.startsWith("RASENGAN_PHASE_")) {
      state.git_checkpoints[phaseStartKey(phaseSuffix(detected))] = getHeadSha(projectDir);
      saveState(projectDir, state);
    }
  }

  if (detected === "RINNEGAN_ACTIVE") return delegateToEye("rinnegan", projectDir, state, out);
  if (detected === "BYAKUGAN_ACTIVE") return delegateToEye("byakugan", projectDir, state, out);
  if (detected.startsWith("RASENGAN_PHASE_")) {
    // Only this phase's tasks: the next phase opens once Sharingan has passed this one.
    return delegateToEye("rasengan", projectDir, state, out, "--phase", phaseSuffix(detected));
  }
  if (detected.startsWith("SHARINGAN_PHASE_")) return emitSharinganAction(projectDir, state, Number(phaseSuffix(detected)), out);
  if (detected === "PIPELINE_COMPLETE") return emitCompletionSummary(projectDir, state, out);
  say(out, `ERROR: Unknown stage: ${detected}`);
  return 1;
}
