import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import type { ScanPlan } from "@quality/types.ts";
import {
  appendProgress,
  checkBudget,
  clearDispatchLog,
  clearSentinel,
  defaultState,
  ensureSentinel,
  isActive,
  isEyeComplete,
  loadState,
  logDispatch,
  readProgress,
  transition,
} from "@dojutsu/dojutsu_state.ts";
import { writeEnrichmentWorkOrders, writeImpactWorkOrders, writeScanWorkOrders } from "@dojutsu/work_orders.ts";

const STATE_FILE = "docs/audit/data/dojutsu-state.json";
const PROGRESS_FILE = "docs/audit/data/dojutsu-progress.jsonl";
const KEY_FILE = "docs/audit/data/.dojutsu-hmac-key";
// A Python-era key: 32 random bytes as 64 ASCII hex characters, signing "<stage>|<last_updated>".
const LEGACY_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LEGACY_SIGNATURE = "82f9c802f3f70848118808e813edfa8868f0094c8dba0356c7043a1a437cedf8";

const legacyState = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      pipeline_id: "legacy-run",
      started_at: "2026-09-01T09:00:00+00:00",
      last_updated: "2026-09-01T10:00:00.123456+00:00",
      stage: "RINNEGAN_ACTIVE",
      current_eye: "rinnegan",
      current_phase: null,
      verified_phases: [],
      flags: { mode: "audit", phases: null, approval: "interactive" },
      failure_counts: { rinnegan: 0, byakugan: 0, rasengan: 0, sharingan: 0 },
      session_count: 3,
      last_agent: "unknown",
      git_checkpoints: {},
      history: [],
      hmac: LEGACY_SIGNATURE,
      ...overrides,
    },
    null,
    2,
  );

interface LoadCase {
  name: string;
  files: Record<string, string>;
  loads: { pipeline_id?: string; stage: string; session_count: number } | null;
}

describe("loadState", () => {
  it.each<LoadCase>([
    {
      name: "a state signed by the Python-era key loads unchanged",
      files: { [STATE_FILE]: legacyState(), [KEY_FILE]: `${LEGACY_KEY}\n` },
      loads: { pipeline_id: "legacy-run", stage: "RINNEGAN_ACTIVE", session_count: 3 },
    },
    { name: "a tampered stage fails the signature", files: { [STATE_FILE]: legacyState({ stage: "AUDIT_COMPLETE" }), [KEY_FILE]: LEGACY_KEY }, loads: null },
    { name: "a tampered timestamp fails the signature", files: { [STATE_FILE]: legacyState({ last_updated: "2026-09-02T10:00:00+00:00" }), [KEY_FILE]: LEGACY_KEY }, loads: null },
    { name: "a different key fails the signature", files: { [STATE_FILE]: legacyState(), [KEY_FILE]: LEGACY_KEY.replace("0", "1") }, loads: null },
    { name: "no state file gives a fresh inactive state", files: {}, loads: { stage: "INACTIVE", session_count: 1 } },
  ])("$name", ({ files, loads }) => {
    const project = projectFiles(files);
    if (loads === null) {
      expect(() => loadState(project)).toThrow(/HMAC mismatch on dojutsu-state.json/);
      return;
    }
    expect(loadState(project)).toMatchObject(loads);
    if (!(STATE_FILE in files)) expect(existsSync(join(project, KEY_FILE))).toBe(false);
  });
});

describe("saveState", () => {
  it("signs with a 0600 key under the project and leaves the working directory empty", () => {
    const root = projectFiles({ "cwd/.keep": "", "project/.keep": "" });
    const cwd = join(root, "cwd");
    const project = join(root, "project");
    const program =
      "const s = await import(process.argv[1]); const state = s.defaultState(); s.saveState(process.argv[2], state); s.loadState(process.argv[2]);";
    const module = join(import.meta.dir, "..", "scripts", "dojutsu_state.ts");

    const result = Bun.spawnSync([process.execPath, "-e", program, module, project], { cwd, stdout: "pipe", stderr: "pipe" });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(cwd)).toEqual([".keep"]);
    expect(statSync(join(project, KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(project, STATE_FILE))).toBe(true);
  });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

interface TransitionCase {
  from: string;
  to: string;
  legal: boolean;
  eye?: string | null;
  phase?: number | null;
}

describe("transition", () => {
  it.each<TransitionCase>([
    { from: "INACTIVE", to: "RINNEGAN_ACTIVE", legal: true, eye: "rinnegan", phase: null },
    { from: "INACTIVE", to: "PIPELINE_COMPLETE", legal: true, eye: null, phase: null },
    { from: "RINNEGAN_ACTIVE", to: "BYAKUGAN_ACTIVE", legal: true, eye: "byakugan", phase: null },
    { from: "BYAKUGAN_ACTIVE", to: "RASENGAN_PHASE_3", legal: true, eye: "rasengan", phase: 3 },
    { from: "BYAKUGAN_ACTIVE", to: "AUDIT_COMPLETE", legal: true },
    { from: "RASENGAN_PHASE_1", to: "RASENGAN_PHASE_2", legal: true, eye: "rasengan", phase: 2 },
    { from: "RASENGAN_PHASE_1", to: "SHARINGAN_PHASE_1", legal: true, eye: "sharingan", phase: 1 },
    { from: "RASENGAN_PHASE_1", to: "PIPELINE_COMPLETE", legal: true, eye: null, phase: null },
    { from: "SHARINGAN_PHASE_1", to: "RASENGAN_PHASE_1", legal: true, eye: "rasengan", phase: 1 },
    { from: "SHARINGAN_PHASE_1", to: "PIPELINE_COMPLETE", legal: true, eye: null, phase: null },
    { from: "AUDIT_COMPLETE", to: "RASENGAN_PHASE_0", legal: true, eye: "rasengan", phase: 0 },
    { from: "AUDIT_COMPLETE", to: "AUDIT_COMPLETE", legal: true },
    { from: "PIPELINE_COMPLETE", to: "RASENGAN_PHASE_2", legal: true, eye: "rasengan", phase: 2 },
    { from: "RINNEGAN_ACTIVE", to: "RASENGAN_PHASE_0", legal: false },
    { from: "RASENGAN_PHASE_1", to: "SHARINGAN_PHASE_2", legal: false },
    { from: "SHARINGAN_PHASE_1", to: "SHARINGAN_PHASE_2", legal: false },
    { from: "BYAKUGAN_ACTIVE", to: "PIPELINE_COMPLETE", legal: false },
    { from: "AUDIT_COMPLETE", to: "BYAKUGAN_ACTIVE", legal: false },
    { from: "PIPELINE_COMPLETE", to: "AUDIT_COMPLETE", legal: false },
  ])("$from -> $to legal=$legal", ({ from, to, legal, eye, phase }) => {
    const project = projectFiles({ ".keep": "" });
    git(project, "init", "-q");
    git(project, "commit", "-q", "--allow-empty", "-m", "base");
    const state = defaultState();
    state.stage = from;

    if (!legal) {
      expect(() => transition(state, to, project)).toThrow(`Illegal transition: ${from} → ${to}. Check pipeline state.`);
      expect(state.stage).toBe(from);
      expect(existsSync(join(project, STATE_FILE))).toBe(false);
      return;
    }
    const reason = eye === undefined ? undefined : "because";
    transition(state, to, project, reason);

    const saved = loadState(project);
    expect(saved.stage).toBe(to);
    expect(saved.history).toMatchObject([{ from, to, reason: reason ?? `auto: ${from} → ${to}` }]);
    expect(typeof saved.stage_entered_at).toBe("string");
    if (eye !== undefined) expect([saved.current_eye, saved.current_phase]).toEqual([eye, phase ?? null]);
    expect(git(project, "tag", "-l", "dojutsu/*")).toBe(`dojutsu/${to.toLowerCase().replaceAll("_", "-")}`);
  });
});

describe("progress narrative", () => {
  it("appends one json.dumps line per entry and reads back only the last entries", () => {
    const project = projectFiles({ ".keep": "" });

    appendProgress(project, { stage: "RINNEGAN_ACTIVE", eye: "rinnegan", summary: "scanned" });
    appendProgress(project, { stage: "BYAKUGAN_ACTIVE", eye: "dojutsu", summary: "Paused", decisions: ["a"], gitCheckpoint: "abc1234", exitReason: "rate_limited" });

    const lines = readFileSync(join(project, PROGRESS_FILE), "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines[0]).toMatch(
      /^\{"timestamp": "[^"]+", "stage": "RINNEGAN_ACTIVE", "eye": "rinnegan", "summary": "scanned", "decisions": \[\], "next_priority": "", "git_checkpoint": "unknown", "exit_reason": null\}$/,
    );
    expect(readProgress(project, 1)).toMatchObject([
      { stage: "BYAKUGAN_ACTIVE", decisions: ["a"], git_checkpoint: "abc1234", exit_reason: "rate_limited" },
    ]);
    expect(readProgress(project).map((entry) => entry["stage"])).toEqual(["RINNEGAN_ACTIVE", "BYAKUGAN_ACTIVE"]);
    expect(readProgress(projectFiles({ ".keep": "" }))).toEqual([]);
  });
});

const DISPATCH_LOG = "docs/audit/data/dispatch-log.jsonl";

interface BudgetCase {
  name: string;
  tokens: number[];
  budget: number | undefined;
  verdict: [boolean, string];
}

describe("dispatch budget", () => {
  it.each<BudgetCase>([
    { name: "no dispatch log leaves the whole budget", tokens: [], budget: undefined, verdict: [true, ""] },
    { name: "exactly the cheapest dispatch still fits", tokens: [400_000, 70_000], budget: undefined, verdict: [true, ""] },
    { name: "one token less than that is paused with the usage spelled out", tokens: [400_000, 70_001], budget: undefined, verdict: [false, "470,001 tokens used of 500,000 budget (29,999 remaining)"] },
    { name: "an explicit budget replaces the default", tokens: [1_000], budget: 31_000, verdict: [true, ""] },
  ])("$name", ({ tokens, budget, verdict }) => {
    const project = projectFiles({ ".keep": "" });
    for (const count of tokens) logDispatch(project, "scan", count, "sonnet");

    expect(budget === undefined ? checkBudget(project) : checkBudget(project, budget)).toEqual(verdict);
  });

  it("logs one json.dumps line per dispatch, skips damaged lines and clears for a new session", () => {
    const project = projectFiles({ [DISPATCH_LOG]: "not json\n" });

    logDispatch(project, "impact_analysis", 30_000, "sonnet");

    const lines = readFileSync(join(project, DISPATCH_LOG), "utf8").split("\n");
    expect(lines[1]).toMatch(/^\{"task": "impact_analysis", "tokens": 30000, "model": "sonnet", "timestamp": "[^"]+"\}$/);
    expect(checkBudget(project, 60_000)).toEqual([true, ""]);
    clearDispatchLog(project);
    expect(existsSync(join(project, DISPATCH_LOG))).toBe(false);
  });
});

const SENTINEL_FILE = "docs/audit/data/.dojutsu-active";

describe("sentinel", () => {
  it("marks the pipeline active with this process id until it is cleared", () => {
    const project = projectFiles({ ".keep": "" });

    ensureSentinel(project);

    expect(readFileSync(join(project, SENTINEL_FILE), "utf8")).toBe(String(process.pid));
    expect(isActive(project)).toBe(true);
    clearSentinel(project);
    expect([existsSync(join(project, SENTINEL_FILE)), isActive(project)]).toEqual([false, false]);
  });

  it.each([
    { name: "a finished process", content: () => String(Bun.spawnSync(["true"]).pid) },
    { name: "text that is not a process id", content: () => "not-a-pid" },
  ])("a sentinel left by $name is stale: not active, and removed", ({ content }) => {
    const project = projectFiles({ [SENTINEL_FILE]: content() });

    expect(isActive(project)).toBe(false);
    expect(existsSync(join(project, SENTINEL_FILE))).toBe(false);
  });
});

describe("isEyeComplete", () => {
  it.each([
    { stdout: "STATE: COMPLETE", eye: "byakugan", complete: true },
    { stdout: "noise\n   STATE: PIPELINE_COMPLETE  \nmore", eye: "rinnegan", complete: true },
    { stdout: "STATE:COMPLETE", eye: "byakugan", complete: true },
    { stdout: "STATE: NEEDS_SCANNING", eye: "rinnegan", complete: false },
    { stdout: "ACTION: wait for STATE: COMPLETE", eye: "rinnegan", complete: false },
    { stdout: "STATE: ALL_PHASES_COMPLETE", eye: "rasengan", complete: true },
    { stdout: "STATE: ALL_PHASES_COMPLETE", eye: "byakugan", complete: false },
  ])("$eye reporting $stdout is complete=$complete", ({ stdout, eye, complete }) => {
    expect(isEyeComplete(stdout, eye)).toBe(complete);
  });
});

const ARTIFACT_PATH = "data/scanner-output/batch-1.jsonl";
const ARTIFACT_TEXT = '{"id":"SCAN-001"}\n';
const ARTIFACT_SHA256 = "e8e4852fb7a603f4aa5064ac2ac576475863f8675aa7868cb5e67cfcc32136f4";

const scanPlan = (status: string): ScanPlan => ({
  total_batches: 1,
  completed: 0,
  batches: [{ id: 1, layer: "components", files: ["src/App.tsx"], status, output_file: ARTIFACT_PATH, finding_count: 0 }],
});

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("writeScanWorkOrders", () => {
  it("tracks the batch artifact: pending without it, complete with its digest, pending again when it goes", () => {
    const audit = projectFiles({ ".keep": "" });
    const workDir = join(audit, "data", "work-orders", "scanner", "batch-1");

    expect(writeScanWorkOrders(audit, scanPlan("pending"))).toBe(1);
    expect(readJson(join(workDir, "status.json"))).toMatchObject({ state: "pending", artifact_path: ARTIFACT_PATH, artifact_present: false });
    expect(readJson(join(workDir, "request.json"))).toMatchObject({ kind: "scanner-batch", id: 1, layer: "components", files: ["src/App.tsx"], artifact_path: ARTIFACT_PATH, state: "pending" });
    expect(existsSync(join(workDir, "response.normalized.json"))).toBe(false);

    mkdirSync(join(audit, "data", "scanner-output"), { recursive: true });
    writeFileSync(join(audit, ARTIFACT_PATH), ARTIFACT_TEXT);
    writeScanWorkOrders(audit, scanPlan("pending"));
    expect(readJson(join(workDir, "status.json"))).toMatchObject({ state: "complete", artifact_present: true });
    expect(readJson(join(workDir, "response.normalized.json"))).toMatchObject({ artifact_path: ARTIFACT_PATH, sha256: ARTIFACT_SHA256, size_bytes: 18, line_count: 1 });
    expect(readFileSync(join(workDir, "response.raw.txt"), "utf8").split("\n").slice(0, 4)).toEqual([
      `artifact_path: ${ARTIFACT_PATH}`,
      `sha256: ${ARTIFACT_SHA256}`,
      "size_bytes: 18",
      "line_count: 1",
    ]);

    rmSync(join(audit, ARTIFACT_PATH));
    writeScanWorkOrders(audit, scanPlan("pending"));
    expect(readJson(join(workDir, "status.json"))).toMatchObject({ state: "pending", artifact_present: false });
    expect([existsSync(join(workDir, "response.raw.txt")), existsSync(join(workDir, "response.normalized.json"))]).toEqual([false, false]);
  });
});

describe("work orders", () => {
  it("a failed batch stays failed even when its artifact exists", () => {
    const audit = projectFiles({ [ARTIFACT_PATH]: ARTIFACT_TEXT });

    writeScanWorkOrders(audit, scanPlan("failed"));

    expect(readJson(join(audit, "data", "work-orders", "scanner", "batch-1", "status.json"))).toMatchObject({ state: "failed", artifact_present: true });
  });

  it("an enrichment order keeps its created_at across rewrites and completes with its layer file", () => {
    const audit = projectFiles({ ".keep": "" });
    const workDir = join(audit, "data", "work-orders", "enrichment", "services");
    expect(writeEnrichmentWorkOrders(audit, { zeta: 1, services: 2 })).toBe(2);
    const first = readJson(join(workDir, "request.json"));
    expect(first).toMatchObject({ kind: "layer-enrichment", layer: "services", finding_count: 2, artifact_path: "data/enriched/services.jsonl", state: "pending" });

    mkdirSync(join(audit, "data", "enriched"), { recursive: true });
    writeFileSync(join(audit, "data", "enriched", "services.jsonl"), '{"id":"ENR-001"}\n');
    writeEnrichmentWorkOrders(audit, { zeta: 1, services: 2 });

    expect(readJson(join(workDir, "request.json"))["created_at"]).toBe(first["created_at"]);
    expect(readJson(join(workDir, "status.json"))["state"]).toBe("complete");
  });

  it("impact orders skip clusters without an id and start completed clusters as complete", () => {
    const audit = projectFiles({ ".keep": "" });
    const clusters = [
      { id: "CLU-001", type: "file", finding_count: 2, finding_ids: ["F-1", "F-2"], files: ["src/a.ts"] },
      { id: "CLU-002", type: "file", finding_count: 1, finding_ids: ["F-3"], files: ["src/b.ts"] },
      { type: "file", finding_count: 1 },
    ];

    expect(writeImpactWorkOrders(audit, clusters, new Set(["CLU-001"]))).toBe(2);

    const root = join(audit, "data", "work-orders", "impact-analysis");
    expect(readJson(join(root, "CLU-001", "request.json"))).toMatchObject({
      kind: "impact-analysis",
      cluster_id: "CLU-001",
      cluster_type: "file",
      finding_count: 2,
      finding_ids: ["F-1", "F-2"],
      files: ["src/a.ts"],
      artifact_path: "deep/impact-analysis-parts/CLU-001.json",
      state: "complete",
    });
    expect(readJson(join(root, "CLU-002", "status.json"))).toMatchObject({ state: "pending", artifact_present: false });
    expect(readdirSync(root).sort()).toEqual(["CLU-001", "CLU-002"]);
  });
});
