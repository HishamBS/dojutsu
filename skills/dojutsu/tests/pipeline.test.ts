import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { defaultState, ensureSentinel, getTokensUsed, loadState, logDispatch, readProgress, saveState } from "@dojutsu/dojutsu_state.ts";
import type { DojutsuState } from "@dojutsu/dojutsu_state.ts";
import { detectStage, runPipeline } from "@dojutsu/run_pipeline_lib.ts";
import type { DojutsuFlags } from "@dojutsu/dojutsu_state.ts";

const BYAKUGAN_PACKAGE = ["dependency-graph.json", "clusters.json", "impact-analysis.jsonl", "narrative.md", "scorecard.md", "deployment-plan.md", "executive-brief.md"];

const bundleVerdict = (stage: string, ok = true): string => JSON.stringify({ stage, ok, errors: [], source_hashes: {} });

// Everything detectStage needs to consider rinnegan and byakugan done.
const auditPackage = (): Record<string, string> => ({
  "docs/audit/master-audit.md": "ok\n",
  "docs/audit/data/bundle-verdict.json": bundleVerdict("byakugan"),
  ...Object.fromEntries(BYAKUGAN_PACKAGE.map((name) => [`docs/audit/deep/${name}`, "ok\n"])),
});

const rasenganState = (value: object): Record<string, string> => ({ "docs/audit/data/rasengan-state.json": JSON.stringify(value) });

interface StageCase {
  name: string;
  files: Record<string, string>;
  state?: Partial<DojutsuState>;
  stage: string;
}

describe("detectStage", () => {
  it.each<StageCase>([
    { name: "rinnegan stays active without a bundle verdict", files: { "docs/audit/master-audit.md": "ok\n" }, stage: "RINNEGAN_ACTIVE" },
    { name: "rinnegan stays active when the bundle verdict is not ok", files: { ...auditPackage(), "docs/audit/data/bundle-verdict.json": bundleVerdict("byakugan", false) }, stage: "RINNEGAN_ACTIVE" },
    {
      name: "byakugan is not complete without the executive brief",
      files: Object.fromEntries(Object.entries(auditPackage()).filter(([path]) => !path.endsWith("executive-brief.md"))),
      stage: "BYAKUGAN_ACTIVE",
    },
    { name: "byakugan stays active when the verdict only covers rinnegan", files: { ...auditPackage(), "docs/audit/data/bundle-verdict.json": bundleVerdict("rinnegan") }, stage: "BYAKUGAN_ACTIVE" },
    { name: "the full byakugan package opens rasengan at phase 0", files: auditPackage(), stage: "RASENGAN_PHASE_0" },
    {
      name: "a phase that was completed but never opened is not sent to sharingan",
      files: { ...auditPackage(), ...rasenganState({ phases_completed: [1], current_phase: 0, status: "in_progress" }) },
      state: { stage: "RASENGAN_PHASE_0", git_checkpoints: { "phase-0-start": "abc1234" } },
      stage: "RASENGAN_PHASE_0",
    },
    {
      name: "an opened phase that rasengan completed goes to sharingan",
      files: { ...auditPackage(), ...rasenganState({ phases_completed: [0], current_phase: 1, status: "in_progress" }) },
      state: { git_checkpoints: { "phase-0-start": "abc1234" } },
      stage: "SHARINGAN_PHASE_0",
    },
    {
      name: "a verified phase lets rasengan's own pointer open the next one",
      files: { ...auditPackage(), ...rasenganState({ phases_completed: [0], current_phase: 1, status: "in_progress" }) },
      state: { verified_phases: [0], git_checkpoints: { "phase-0-start": "abc1234" } },
      stage: "RASENGAN_PHASE_1",
    },
    {
      name: "--phases keeps rasengan to the selected pending phases",
      files: { ...auditPackage(), ...rasenganState({ phases_completed: [0], phases_pending: [1, 2], current_phase: 1, status: "in_progress" }) },
      state: { verified_phases: [0], git_checkpoints: { "phase-0-start": "abc1234" }, flags: { mode: "fix", phases: [2], approval: "auto" } },
      stage: "RASENGAN_PHASE_2",
    },
    {
      name: "a completed rasengan with every phase verified is the end of the pipeline",
      files: { ...auditPackage(), ...rasenganState({ phases_completed: [0], current_phase: null, status: "completed" }) },
      state: { verified_phases: [0], git_checkpoints: { "phase-0-start": "abc1234" } },
      stage: "PIPELINE_COMPLETE",
    },
  ])("$name", ({ files, state, stage }) => {
    const project = projectFiles(files);

    expect(detectStage(project, { ...defaultState(), ...state })).toBe(stage);
  });
});

const FIX_AUTO: DojutsuFlags = { mode: "fix", phases: null, approval: "auto", resume: false, status: false, report: false, clean: false };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

async function run(project: string, flags: DojutsuFlags = FIX_AUTO): Promise<{ output: string; code: number }> {
  let output = "";
  const code = await runPipeline(project, flags, (text) => (output += text));
  return { output, code };
}

// A repo with phase 0 fixed and awaiting Sharingan; returns where its verdict file belongs.
function awaitingSharingan(rasengan: object): { project: string; phaseStart: string; head: string; verdictPath: string } {
  const project = projectFiles({ ...auditPackage(), ...rasenganState(rasengan), "docs/audit/data/tasks/phase-0-tasks.json": JSON.stringify({ phase: 0, tasks: [] }) });
  git(project, "init", "-q");
  git(project, "commit", "-q", "--allow-empty", "-m", "before phase 0");
  const phaseStart = git(project, "rev-parse", "--short", "HEAD");
  git(project, "commit", "-q", "--allow-empty", "-m", "fix(phase-0)");
  const head = git(project, "rev-parse", "--short", "HEAD");
  const state = loadState(project);
  state.stage = "SHARINGAN_PHASE_0";
  state.git_checkpoints["phase-0-start"] = phaseStart;
  saveState(project, state);
  return { project, phaseStart, head, verdictPath: join(project, ".sharingan", `${head}.verdict.json`) };
}

describe("runPipeline sharingan verification", () => {
  it.each([
    { name: "advances to rasengan's next phase", rasengan: { phases_completed: [0], current_phase: 1, status: "in_progress" }, next: "RASENGAN_PHASE_1" },
    { name: "completes the pipeline after the last phase", rasengan: { phases_completed: [0], current_phase: null, status: "completed" }, next: "PIPELINE_COMPLETE" },
  ])("a passing verdict for the phase range verifies it and $name", async ({ rasengan, next }) => {
    const { project, phaseStart, head, verdictPath } = awaitingSharingan(rasengan);

    writeJson(verdictPath, { commit: head, base: phaseStart, verdict: "BLOCKED" });
    await run(project);
    const blocked = loadState(project);
    expect([blocked.stage, blocked.verified_phases]).toEqual(["SHARINGAN_PHASE_0", []]);

    writeJson(verdictPath, { commit: head, base: phaseStart, verdict: "CLEAR" });
    await run(project);
    const cleared = loadState(project);
    expect([cleared.stage, cleared.verified_phases]).toEqual([next, [0]]);
  });

  it("a verdict for another base or commit verifies nothing", async () => {
    const { project, phaseStart, head, verdictPath } = awaitingSharingan({ phases_completed: [0], current_phase: null, status: "completed" });

    writeJson(verdictPath, { commit: head, base: "0000000", verdict: "CLEAR" });
    await run(project);
    writeJson(verdictPath, { commit: "0000000", base: phaseStart, verdict: "CLEAR" });
    await run(project);

    expect(loadState(project).verified_phases).toEqual([]);
  });

  it.each<{ name: string; phases: number[] | null; fixed: string }>([
    { name: "all phases", phases: null, fixed: "all phases" },
    { name: "the selected phases", phases: [2], fixed: "phases [2]" },
  ])("the last verified phase ends the pipeline with a summary naming $name", async ({ phases, fixed }) => {
    const { project, phaseStart, head, verdictPath } = awaitingSharingan({ phases_completed: [0], current_phase: null, status: "completed" });
    writeJson(verdictPath, { commit: head, base: phaseStart, verdict: "CLEAR" });
    writeFileSync(join(project, "docs/audit/data/findings.jsonl"), '{"id": "F-1"}\n{"id": "F-2"}\n');
    ensureSentinel(project);

    const { output, code } = await run(project, { ...FIX_AUTO, phases });

    expect(code).toBe(0);
    expect(output.slice(output.indexOf("PIPELINE_COMPLETE"))).toBe(
      [
        "PIPELINE_COMPLETE",
        "",
        "  Rinnegan: 2 findings detected",
        `  Byakugan: deep analysis in ${project}/docs/audit/deep/`,
        `  Rasengan: ${fixed} fixed`,
        "  Sharingan: 1 phases verified (CLEAR or INFRA_*)",
        "  Sessions used: 1",
        `  Pipeline ID: ${stateOnDisk(project).pipeline_id}`,
        "",
      ].join("\n"),
    );
    expect(existsSync(join(project, "docs/audit/data/.dojutsu-active"))).toBe(false);
    expect(readProgress(project, 1)).toMatchObject([{ stage: "PIPELINE_COMPLETE", eye: "dojutsu", summary: "Pipeline complete: 2 findings, 1 phases verified", git_checkpoint: head }]);
  });

  it("an interactive fix run stops for approval once the phase is verified", async () => {
    const { project, phaseStart, head, verdictPath } = awaitingSharingan({ phases_completed: [0], current_phase: 1, status: "in_progress" });
    writeJson(verdictPath, { commit: head, base: phaseStart, verdict: "INFRA_DEGRADED" });

    const { output, code } = await run(project, { ...FIX_AUTO, approval: "interactive" });

    expect(code).toBe(0);
    expect(output).toContain("\n[dojutsu] === PHASE 0 VERIFIED (INFRA_DEGRADED) ===\n[dojutsu] To continue to next phase, run this script again.\n");
    const state = loadState(project);
    expect([state.stage, state.verified_phases]).toEqual(["SHARINGAN_PHASE_0", [0]]);
  });

  it("tells the LLM to run sharingan over the phase range and which verdicts let it go on", async () => {
    const { project, phaseStart } = awaitingSharingan({ phases_completed: [0], current_phase: 1, status: "in_progress" });

    const { output } = await run(project);

    expect(output.slice(output.indexOf("STAGE: SHARINGAN_PHASE_0"))).toBe(
      [
        "STAGE: SHARINGAN_PHASE_0",
        `SKILL_DIR: ${join(import.meta.dir, "..")}`,
        `PROJECT_DIR: ${project}`,
        "",
        "Phase 0 is complete. Verify it with Sharingan over the phase range.",
        "",
        `ACTION: Run: ~/.coding-agent/sharingan/run.sh --base ${phaseStart}`,
        `  Phase requirements: ${project}/docs/audit/data/tasks/phase-0-tasks.json`,
        `  Verdict file: ${realpathSync(project)}/.sharingan/<HEAD sha>.verdict.json`,
        "",
        "  CLEAR or INFRA_* → run this script again",
        "  BLOCKED or PARTIAL → fix what the verdict names, commit, then run this script again",
        "",
      ].join("\n"),
    );
  });
});

// A HIGH task as rasengan hands it out: no current_code for revalidation to chase.
const task = (id: string, status = "pending"): Record<string, unknown> => ({
  id,
  file: "src/app.ts",
  line: 1,
  rule: "R14",
  severity: "HIGH",
  status,
  search_pattern: "console.log",
  target_code: "logger.info(msg)",
  fix_plan: null,
  explanation: "Use structured logging.",
  ...(status === "completed" ? { resolution: "applied" } : {}),
});

const writeTasks = (dataDir: string, phase: number, tasks: Record<string, unknown>[]): void =>
  writeJson(join(dataDir, "tasks", `phase-${phase}-tasks.json`), { phase, phase_name: `phase-${phase}`, tasks });

// A git repo whose audit is complete, holding rasengan's task files. Returns the data dir.
function auditedRepo(tasksByPhase: Record<number, Record<string, unknown>[]>): { project: string; dataDir: string } {
  const project = projectFiles(auditPackage());
  git(project, "init", "-q");
  git(project, "commit", "-q", "--allow-empty", "-m", "audited");
  const dataDir = join(project, "docs", "audit", "data");
  for (const [phase, tasks] of Object.entries(tasksByPhase)) writeTasks(dataDir, Number(phase), tasks);
  return { project, dataDir };
}

const stateOnDisk = (project: string): DojutsuState => loadState(project);

describe("runPipeline phase loop", () => {
  it("a finished phase goes to sharingan before the next phase is handed out", async () => {
    const { project, dataDir } = auditedRepo({ 0: [task("A-0")], 1: [task("B-1")] });
    await run(project); // opens phase 0, hands out A-0
    writeTasks(dataDir, 0, [task("A-0", "completed")]);
    git(project, "commit", "-q", "--allow-empty", "-m", "fix(phase-0): phase-0 - 1 applied");

    const finishing = await run(project);
    await run(project);

    expect(finishing.output).not.toContain("id=B-1");
    expect(stateOnDisk(project).stage).toBe("SHARINGAN_PHASE_0");
  });

  it.each([
    { name: "the first fix run after the audit", rasengan: null },
    { name: "rasengan's pointer already on phase 1", rasengan: { phases_completed: [0], current_phase: 1, status: "in_progress" } },
  ])("--phases 2 opens phase 2 and hands out its task in the same run: $name", async ({ rasengan }) => {
    const { project, dataDir } = auditedRepo({ 0: [task("A-0", "completed")], 1: [task("B-1")], 2: [task("C-2")] });
    if (rasengan !== null) writeJson(join(dataDir, "rasengan-state.json"), rasengan);

    const { output } = await run(project, { ...FIX_AUTO, phases: [2] });

    expect(output).toContain("NEXT_TASK: index=0 id=C-2");
    expect(stateOnDisk(project).stage).toBe("RASENGAN_PHASE_2");
  });

  it.each<{ name: string; later: Record<number, Record<string, unknown>[]>; next: string }>([
    { name: "another phase follows", later: { 1: [task("B-1")] }, next: "RASENGAN_PHASE_1" },
    { name: "none does", later: {}, next: "PIPELINE_COMPLETE" },
  ])("a phase opened with nothing left to fix moves on without sharingan: $name", async ({ later, next }) => {
    const { project } = auditedRepo({ 0: [task("A-0", "completed")], ...later });
    await run(project); // opens phase 0; rasengan finds it done

    const { output } = await run(project);

    expect(output).not.toContain("sharingan/run.sh");
    expect(stateOnDisk(project).stage).toBe(next);
  });

  it("a later run opens a phase an earlier filtered run left out", async () => {
    const { project, dataDir } = auditedRepo({ 0: [task("A-0")], 1: [task("B-1", "completed")] });
    writeJson(join(dataDir, "rasengan-state.json"), { phases_completed: [1], phases_pending: [0], current_phase: 0, status: "in_progress" });
    const state = loadState(project);
    state.stage = "PIPELINE_COMPLETE";
    state.verified_phases = [1];
    state.git_checkpoints["phase-1-start"] = git(project, "rev-parse", "--short", "HEAD");
    saveState(project, state);

    const { output } = await run(project, { ...FIX_AUTO, phases: [0] });

    expect(output).toContain("NEXT_TASK: index=0 id=A-0");
    expect(stateOnDisk(project).stage).toBe("RASENGAN_PHASE_0");
  });
});

const DOJUTSU_CLI = join(import.meta.dir, "..", "scripts", "run-pipeline.ts");
const DOJUTSU_USAGE = [
  "usage: dojutsu [-h] [--status | --report | --clean] [--fix] [--phases PHASES]",
  "               [--auto | --interactive] [--resume]",
  "               project_dir",
].join("\n");

function runCli(argv: string[], env: Record<string, string | undefined> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, DOJUTSU_CLI, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("dojutsu run-pipeline CLI", () => {
  it.each<{ name: string; argv: string[]; error: string }>([
    { name: "--phases without --fix", argv: ["x", "--phases", "1"], error: "--phases requires --fix" },
    { name: "--auto without --fix", argv: ["x", "--auto"], error: "--auto requires --fix" },
    { name: "two information flags", argv: ["x", "--status", "--report"], error: "argument --report: not allowed with argument --status" },
    { name: "--auto with --interactive", argv: ["x", "--fix", "--auto", "--interactive"], error: "argument --interactive: not allowed with argument --auto" },
    { name: "no project directory", argv: [], error: "the following arguments are required: project_dir" },
  ])("$name is a usage error", ({ argv, error }) => {
    const { status, stdout, stderr } = runCli(argv);

    expect([status, stdout]).toEqual([2, ""]);
    expect(stderr).toBe(`${DOJUTSU_USAGE}\ndojutsu: error: ${error}\n`);
  });

  it("runs rasengan and task revalidation on the running bun, not one found on PATH", () => {
    const fakeBin = projectFiles({ bun: "#!/bin/sh\nexit 97\n" });
    chmodSync(join(fakeBin, "bun"), 0o755);
    const { project } = auditedRepo({ 0: [task("A-0")] });
    const env = { PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` };

    runCli([project, "--fix", "--auto"], env); // opens phase 0
    const { status, stdout } = runCli([project, "--fix", "--auto"], env); // revalidates at startup, then asks rasengan

    expect(status).toBe(0);
    expect(stdout).toContain("Revalidating tasks in");
    expect(stdout).toContain("NEXT_TASK: index=0 id=A-0");
  });
});

const savedStateWith = (project: string, patch: Partial<DojutsuState>): void => {
  const state = loadState(project);
  Object.assign(state, patch);
  saveState(project, state);
};

describe("dojutsu run-pipeline CLI information flags", () => {
  it("--status with no saved state shows a fresh inactive pipeline", () => {
    const { status, stdout } = runCli([projectFiles({ ".keep": "" }), "--status"]);

    expect([status, stdout]).toEqual([0, "[dojutsu] Stage: INACTIVE\n[dojutsu] Mode: audit\n[dojutsu] Verified phases: []\n[dojutsu] Sessions: 1\n"]);
  });

  it("--status prints the saved stage, mode, verified phases, sessions and phase filter", () => {
    const project = projectFiles({ ".keep": "" });
    savedStateWith(project, { stage: "RASENGAN_PHASE_0", flags: { mode: "fix", phases: [0, 2], approval: "auto" }, verified_phases: [1], session_count: 3 });

    const { status, stdout } = runCli([project, "--status"]);

    expect(status).toBe(0);
    expect(stdout).toBe(
      "[dojutsu] Stage: RASENGAN_PHASE_0\n[dojutsu] Mode: fix\n[dojutsu] Verified phases: [1]\n[dojutsu] Sessions: 3\n[dojutsu] Phase filter: [0, 2]\n",
    );
  });

  it("--status treats a state that fails its signature as no state", () => {
    const project = projectFiles({ ".keep": "" });
    savedStateWith(project, { stage: "RINNEGAN_ACTIVE" });
    const statePath = join(project, "docs/audit/data/dojutsu-state.json");
    writeFileSync(statePath, readFileSync(statePath, "utf8").replace("RINNEGAN_ACTIVE", "AUDIT_COMPLETE"));

    expect(runCli([project, "--status"]).stdout).toBe("[dojutsu] No pipeline state found.\n");
  });

  it("--report says how to regenerate the reports", () => {
    const project = projectFiles({ ".keep": "" });

    const { status, stdout } = runCli([project, "--report"]);

    expect([status, stdout]).toEqual([0, `[dojutsu] To regenerate reports, delete existing files in ${project}/docs/audit/deep/ then run audit.\n`]);
  });
});

describe("runPipeline modes and sessions", () => {
  it("audit mode stops at the read-only summary once the audit package is complete", async () => {
    const { project } = auditedRepo({ 0: [task("A-0")] });
    writeFileSync(join(project, "docs/audit/data/findings.jsonl"), '{"id": "F-1"}\n{"id": "F-2"}\n{"id": "F-3"}\n');
    ensureSentinel(project);

    const { output, code } = await run(project, { mode: "audit", phases: null, approval: "interactive" });

    expect(code).toBe(0);
    expect(output).toBe(
      [
        "",
        "[dojutsu] === AUDIT COMPLETE (read-only mode) ===",
        "[dojutsu]",
        "[dojutsu] Findings: 3",
        `[dojutsu] Narrative: ${project}/docs/audit/deep/narrative.md`,
        `[dojutsu] Scorecard: ${project}/docs/audit/deep/scorecard.md`,
        `[dojutsu] Deployment plan: ${project}/docs/audit/deep/deployment-plan.md`,
        "[dojutsu]",
        "[dojutsu] To proceed with fixes:",
        "[dojutsu]   Run with --fix                    (interactive, approve per phase)",
        "[dojutsu]   Run with --fix --phases 0,1,2     (fix selected phases only)",
        "[dojutsu]   Run with --fix --auto             (fully autonomous)",
        "",
        "",
      ].join("\n"),
    );
    expect(readProgress(project, 1)).toMatchObject([{ stage: "AUDIT_COMPLETE", eye: "dojutsu", summary: "Audit complete: 3 findings. Fix mode not enabled." }]);
    expect(existsSync(join(project, "docs/audit/data/.dojutsu-active"))).toBe(false);
    expect(stateOnDisk(project).stage).toBe("INACTIVE");
  });

  it.each<{ name: string; flags: Partial<DojutsuFlags> | null; handsOutTask: boolean }>([
    { name: "explicit flags replace the saved ones", flags: { mode: "audit" }, handsOutTask: false },
    { name: "--resume keeps the saved flags", flags: { resume: true }, handsOutTask: true },
    { name: "no flags at all use the saved ones", flags: null, handsOutTask: true },
  ])("$name", async ({ flags, handsOutTask }) => {
    const { project } = auditedRepo({ 0: [task("A-0")] });
    savedStateWith(project, { flags: { mode: "fix", phases: [0], approval: "auto" } });

    const { output } = await run(project, flags as DojutsuFlags);

    expect(output.includes("NEXT_TASK: index=0 id=A-0")).toBe(handsOutTask);
    if (handsOutTask) expect(stateOnDisk(project).flags).toMatchObject({ mode: "fix", phases: [0], approval: "auto" });
  });

  it("pauses when the session budget is spent, and the next run resumes as a new session", async () => {
    const { project } = auditedRepo({ 0: [task("A-0")] });
    logDispatch(project, "impact_analysis", 1_980_000, "sonnet");
    const reason = "1,980,000 tokens used of 2,000,000 budget (20,000 remaining)";

    const paused = await run(project);

    expect(paused.code).toBe(0);
    expect(paused.output).toBe(
      [
        "",
        "[dojutsu] === PIPELINE PAUSED ===",
        `[dojutsu] Reason: ${reason}`,
        "[dojutsu] Tokens used this session: 1,980,000 / 2,000,000",
        "[dojutsu]",
        "[dojutsu] To resume: start a new session and type /dojutsu",
        "[dojutsu] The pipeline picks up exactly where it left off.",
        "",
        "",
      ].join("\n"),
    );
    expect(readProgress(project, 1)).toMatchObject([{ exit_reason: "rate_limited", summary: `Paused: ${reason} (1,980,000 tokens used)` }]);

    const resumed = await run(project);

    expect(resumed.output).toContain(`\n[dojutsu] === RESUMING PIPELINE (session 2) ===\n[dojutsu]\n[dojutsu] Previous session: Paused: ${reason} (1,980,000 tokens used)\n`);
    expect(resumed.output).toContain("NEXT_TASK: index=0 id=A-0");
    expect(existsSync(join(project, "docs/audit/data/dispatch-log.jsonl"))).toBe(true);
    expect(getTokensUsed(project)).toBe(5000);
  });
});

describe("runPipeline eye failures", () => {
  const breakTasks = (project: string, content: string): void => writeFileSync(join(project, "docs/audit/data/tasks/phase-0-tasks.json"), content);

  it("counts a failing eye, warns from the second failure and blocks the fourth", async () => {
    const { project } = auditedRepo({ 0: [task("A-0")] });
    breakTasks(project, "{");

    const first = await run(project);
    const second = await run(project);
    await run(project);
    const fourth = await run(project);

    expect(first.code).toBe(1);
    expect(first.output).toContain("ERROR: rasengan script failed (attempt 1):\n");
    expect(first.output).toContain("\nACTION: Investigate and fix, then run this script again.\n");
    expect(first.output).not.toContain("Consider model escalation");
    expect(second.output).toContain("WARNING: rasengan failed 2 times. Consider model escalation.\n");
    expect(fourth.output).toContain("BLOCKED: rasengan failed 4 times. Human review required.\n  Last error: ");
    expect(stateOnDisk(project).failure_counts).toMatchObject({ rasengan: 4 });
  });

  it("pauses instead of retrying when the eye's error output says it was rate limited", async () => {
    const { project } = auditedRepo({ 0: [task("A-0")] });
    breakTasks(project, "quota");

    const { output, code } = await run(project);

    expect(code).toBe(0);
    expect(output).toContain("[dojutsu] Reason: Rate limited by provider\n");
    expect(readProgress(project, 1)).toMatchObject([{ exit_reason: "rate_limited", summary: "Paused: Rate limited by provider (0 tokens used)" }]);
    expect(stateOnDisk(project).failure_counts).toMatchObject({ rasengan: 0 });
  });
});
