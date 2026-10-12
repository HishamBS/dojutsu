import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { revalidateAll } from "@rinnegan/revalidate-tasks.ts";
import { runPipeline } from "@rasengan/run_pipeline_lib.ts";

const SKILL_DIR = join(import.meta.dir, "..");

type Task = Record<string, unknown>;

const task = (id: string, overrides: Task = {}): Task => ({
  id,
  file: "src/app.ts",
  line: 10,
  rule: "R14",
  severity: "HIGH",
  status: "pending",
  search_pattern: "console.log",
  target_code: "logger.info(msg)",
  fix_plan: null,
  explanation: "Use structured logging.",
  ...overrides,
});

interface ProjectSpec {
  phases?: Record<number, Task[]>;
  stack?: string;
  files?: Record<string, string>;
}

function makeProject({ phases = { 0: [task("BLD-001")] }, stack = "typescript", files = {} }: ProjectSpec = {}): string {
  const written: Record<string, string> = {
    "docs/audit/data/inventory.json": JSON.stringify({ stack, files: [], total_files: 0, total_loc: 0 }),
    ...files,
  };
  for (const [phase, tasks] of Object.entries(phases)) {
    written[`docs/audit/data/tasks/phase-${phase}-tasks.json`] = JSON.stringify({ phase: Number(phase), phase_name: `phase-${phase}`, tasks });
  }
  return projectFiles(written);
}

function run(project: string, options: { phase?: number } = {}): { output: string; code: number } {
  let output = "";
  const code = runPipeline(project, { ...options, out: (text) => (output += text) });
  return { output, code };
}

describe("runPipeline", () => {
  it("hands out the first pending task as one NEXT_TASK/ACTION block", () => {
    const project = makeProject();
    const audit = `${project}/docs/audit`;

    const { output, code } = run(project);

    expect(code).toBe(0);
    expect(output).toBe(
      [
        `AUDIT_DIR: ${audit}`,
        `SKILL_DIR: ${SKILL_DIR}`,
        `PROJECT_DIR: ${project}`,
        "",
        "PHASE: 0 (phase-0)",
        "  Total: 1, Pending: 1, Done: 0, Failed: 0",
        `  File: ${audit}/data/tasks/phase-0-tasks.json`,
        "",
        "NEXT_TASK: index=0 id=BLD-001",
        "  File: src/app.ts:10",
        "  Rule: R14 | Severity: HIGH",
        "  search_pattern: console.log",
        "  Has target_code: True",
        "  Has fix_plan: False",
        "",
        "ACTION: Fix this violation.",
        "  MODEL: sonnet",
        "  1. Read file: src/app.ts",
        "  2. Find pattern 'console.log' near line 10",
        "  3. Apply: Edit tool, replace with target_code",
        "     TARGET: logger.info(msg)",
        "  4. Verify fix present in file",
        "  5. Update phase-0-tasks.json index 0: set status='completed', resolution='applied', completed_at='<current ISO timestamp>'",
        "  6. Verify build: run `bunx tsc --noEmit` and fix any errors before proceeding",
        "  7. Run this script again for next task",
        "",
        "  EXPLANATION: Use structured logging.",
        "",
      ].join("\n"),
    );
  });
});

const SOURCE = ["// header", "import x from './x';", "const a = 1;", "console.log(msg);", "export {};"].join("\n");
const NO_STATS = { valid: 0, line_updated: 0, already_resolved: 0, needs_rescan: 0, skipped: 0 };
const filler = (count: number): string[] => Array.from({ length: count }, (_, index) => `const filler${index} = ${index};`);

interface RevalidationCase {
  name: string;
  source: string | null;
  task: Task;
  stats: Partial<typeof NO_STATS>;
  after: Task;
}

describe("revalidateAll", () => {
  it.each<RevalidationCase>([
    {
      name: "code still at the cited line stays valid and untouched",
      source: SOURCE,
      task: { line: 4, current_code: "console.log(msg);" },
      stats: { valid: 1 },
      after: { status: "pending", line: 4 },
    },
    {
      name: "code a couple of lines away moves the cited line",
      source: SOURCE,
      task: { line: 2, current_code: "console.log(msg);" },
      stats: { line_updated: 1 },
      after: { status: "pending", line: 4, original_line: 2, line_shifted: true },
    },
    {
      name: "code fifty lines away is still just a line update",
      source: [...filler(54), "console.log(msg);"].join("\n"),
      task: { line: 5, current_code: "console.log(msg);" },
      stats: { line_updated: 1 },
      after: { status: "pending", line: 55, original_line: 5, line_shifted: true },
    },
    {
      name: "code more than fifty lines away needs a rescan and says so",
      source: [...filler(54), "console.log(msg);"].join("\n"),
      task: { line: 4, current_code: "console.log(msg);" },
      stats: { needs_rescan: 1 },
      after: { status: "pending", line: 55, original_line: 4, line_shifted: true, notes: "Line shifted by 51 — verify fix still applies" },
    },
    {
      name: "code no longer in the file resolves the task",
      source: SOURCE,
      task: { line: 4, current_code: "legacyCall(msg);" },
      stats: { already_resolved: 1 },
      after: { status: "completed", resolution: "already_resolved", notes: "Code no longer present in file (likely fixed by earlier phase)" },
    },
    {
      name: "a deleted file resolves the task",
      source: null,
      task: { line: 4, current_code: "console.log(msg);" },
      stats: { already_resolved: 1 },
      after: { status: "completed", resolution: "already_resolved", notes: "File no longer exists" },
    },
    {
      name: "code too short to validate is trusted",
      source: SOURCE,
      task: { line: 3, current_code: "x=1" },
      stats: { valid: 1 },
      after: { status: "pending", line: 3 },
    },
    {
      name: "a task that is not pending is skipped",
      source: SOURCE,
      task: { line: 4, current_code: "legacyCall(msg);", status: "completed", resolution: "applied" },
      stats: { skipped: 1 },
      after: { status: "completed", resolution: "applied" },
    },
  ])("$name", ({ source, task: overrides, stats, after }) => {
    const project = makeProject({ phases: { 0: [task("BLD-001", overrides)] }, files: source === null ? {} : { "src/app.ts": source } });

    const result = revalidateAll(project);

    expect(result).toEqual({ ...NO_STATS, ...stats });
    const saved = JSON.parse(readFileSync(join(project, "docs/audit/data/tasks/phase-0-tasks.json"), "utf8")) as { tasks: Task[] };
    expect(saved.tasks[0]).toMatchObject(after);
  });
});

const done = (id: string, resolution = "applied", status = "completed"): Task => task(id, { status, resolution });
const stateOf = (project: string): Record<string, unknown> => JSON.parse(readFileSync(join(project, "docs/audit/data/rasengan-state.json"), "utf8")) as Record<string, unknown>;

interface SyncCase {
  name: string;
  phases: Record<number, Task[]>;
  existingState?: Record<string, unknown>;
  state: Record<string, unknown>;
  progressRows: string[];
}

describe("runPipeline state and progress", () => {
  it.each<SyncCase>([
    {
      name: "counts and phases come from the task data, not from what was recorded",
      phases: { 0: [done("A-1"), done("A-2", "already_resolved"), task("A-3")], 1: [done("B-1")] },
      state: { total_tasks: 4, tasks_resolved: 3, phases_completed: [1], phases_pending: [0], status: "in_progress", current_phase: 0, current_task_id: "A-3", session_count: 1 },
      progressRows: ["| 0 | phase-0 | 3 | 2 | IN PROGRESS |", "| 1 | phase-1 | 1 | 1 | COMPLETE |"],
    },
    {
      name: "skipped and failed tasks are counted apart from resolved ones",
      phases: { 0: [done("A-1", "skipped", "skipped"), done("A-2", "failed"), task("A-3")] },
      state: { tasks_skipped: 1, tasks_failed: 1, tasks_resolved: 0 },
      progressRows: ["| 0 | phase-0 | 3 | 2 | IN PROGRESS |"],
    },
    {
      name: "an earlier state file counts a new session and keeps what it holds",
      phases: { 0: [task("A-1")] },
      existingState: { started_at: "2026-03-16T10:00:00Z", session_count: 2, custom: "kept" },
      state: { started_at: "2026-03-16T10:00:00Z", session_count: 3, custom: "kept" },
      progressRows: ["| 0 | phase-0 | 1 | 0 | NOT STARTED |"],
    },
    {
      name: "when every task is done the state is completed with no current phase or task",
      phases: { 0: [done("A-1")], 1: [] },
      state: { status: "completed", current_phase: null, current_task_id: null, phases_completed: [0, 1], phases_pending: [] },
      progressRows: ["| 0 | phase-0 | 1 | 1 | COMPLETE |", "| 1 | phase-1 | 0 | 0 | EMPTY |"],
    },
  ])("$name", ({ phases, existingState, state, progressRows }) => {
    const project = makeProject({ phases, files: existingState === undefined ? {} : { "docs/audit/data/rasengan-state.json": JSON.stringify(existingState) } });

    expect(run(project).code).toBe(0);

    expect(stateOf(project)).toMatchObject(state);
    expect(typeof stateOf(project)["last_updated"]).toBe("string");
    const progress = readFileSync(join(project, "docs/audit/progress.md"), "utf8").split("\n");
    expect(progress.slice(0, 2)).toEqual(["# Audit Remediation Progress", ""]);
    expect(progress[2]).toMatch(/^> \*\*Updated:\*\* \d{4}-\d\d-\d\dT[\d:.]+\+00:00 \| \*\*Total Findings:\*\* \d+$/);
    expect(progress.slice(3)).toEqual(["", "## Phase Status", "", "| Phase | Name | Findings | Completed | Status |", "|-------|------|----------|-----------|--------|", ...progressRows, ""]);
  });
});

interface FlowCase {
  name: string;
  phases: Record<number, Task[]>;
  options?: { phase?: number };
  contains: string[];
  absent?: string[];
  current: { phase: number | null; task: string | null };
}

describe("runPipeline phase flow", () => {
  it("reports a project without task files and writes nothing", () => {
    const project = projectFiles({ ".keep": "" });

    const { output, code } = run(project);

    expect(code).toBe(1);
    expect(output).toBe(`ERROR: No task files found. Run /rinnegan first.\nExpected: ${project}/docs/audit/data/tasks/phase-*-tasks.json\n`);
    expect(existsSync(join(project, "docs/audit"))).toBe(false);
  });

  it.each<FlowCase>([
    {
      name: "the next phase opens once the one before it has no task left",
      phases: { 0: [done("A-1")], 1: [task("B-1", { file: "src/auth.ts", rule: "R05", severity: "CRITICAL" })] },
      contains: ["PHASE: 1 (phase-1)", "NEXT_TASK: index=0 id=B-1"],
      absent: ["ALL_PHASES_COMPLETE"],
      current: { phase: 1, task: "B-1" },
    },
    {
      name: "phase numbers sort numerically: phase 2 before phase 10",
      phases: { 10: [task("T-10")], 2: [task("T-2")] },
      contains: ["PHASE: 2 (phase-2)", "id=T-2"],
      current: { phase: 2, task: "T-2" },
    },
    {
      name: "a selected phase is handed out even when an earlier phase still has tasks",
      phases: { 0: [task("A-1")], 1: [task("B-1")] },
      options: { phase: 1 },
      contains: ["PHASE: 1 (phase-1)", "id=B-1"],
      absent: ["id=A-1"],
      current: { phase: 1, task: "B-1" },
    },
    {
      name: "a selected phase with nothing pending reports PHASE_COMPLETE instead of opening the next",
      phases: { 0: [done("A-1")], 1: [task("B-1")] },
      options: { phase: 0 },
      contains: [
        "\nPHASE_COMPLETE: 0\n  No pending tasks in phase 0.\n",
        "\nACTION: Commit the phase's fixes (fix(phase-0): [phase-name] - X applied), then run this script again.\n",
      ],
      absent: ["NEXT_TASK", "id=B-1"],
      current: { phase: 1, task: "B-1" },
    },
    {
      name: "a selected phase that does not exist reports PHASE_COMPLETE too",
      phases: { 0: [task("A-1")] },
      options: { phase: 7 },
      contains: ["PHASE_COMPLETE: 7"],
      absent: ["NEXT_TASK"],
      current: { phase: 0, task: "A-1" },
    },
  ])("$name", ({ phases, options, contains, absent, current }) => {
    const project = makeProject({ phases });

    const { output, code } = run(project, options);

    expect(code).toBe(0);
    for (const text of contains) expect(output).toContain(text);
    for (const text of absent ?? []) expect(output).not.toContain(text);
    expect([stateOf(project)["current_phase"], stateOf(project)["current_task_id"]]).toEqual([current.phase, current.task]);
  });

  it("finishing every phase prints the totals and where to verify and report", () => {
    const project = makeProject({ phases: { 0: [done("A-1"), done("A-2", "already_resolved")] } });

    const { output, code } = run(project);

    expect(code).toBe(0);
    expect(output).toBe(
      [
        `AUDIT_DIR: ${project}/docs/audit`,
        `SKILL_DIR: ${SKILL_DIR}`,
        `PROJECT_DIR: ${project}`,
        "",
        "ALL_PHASES_COMPLETE",
        "  Total: 2, Resolved: 2",
        "  Skipped: 0, Failed: 0",
        "",
        "ACTION: Final verification and report.",
        `  Run: ${SKILL_DIR}/verify-phase.sh on each completed phase`,
        `  Read: ${SKILL_DIR}/report-generator-prompt.md for report structure`,
        `  Write: ${project}/docs/audit/data/rasengan-results.json`,
        "",
      ].join("\n"),
    );
  });
});

const savedTasks = (project: string, phase = 0): Task[] =>
  (JSON.parse(readFileSync(join(project, `docs/audit/data/tasks/phase-${phase}-tasks.json`), "utf8")) as { tasks: Task[] }).tasks;

interface ActionCase {
  name: string;
  stack?: string;
  overrides: Task;
  contains: string[];
}

describe("runPipeline action block", () => {
  it.each<ActionCase>([
    { name: "python projects verify with py_compile", stack: "python", overrides: {}, contains: ["  6. Verify build: run `python3 -m py_compile` and fix any errors before proceeding"] },
    { name: "java projects verify with mvn", stack: "java", overrides: {}, contains: ["  6. Verify build: run `mvn compile -q` and fix any errors before proceeding"] },
    { name: "an unknown stack still asks for a build check", stack: "rust", overrides: {}, contains: ["  6. Verify build: run the project build command and fix any errors before proceeding"] },
    {
      name: "a fix plan is listed step by step when there is no target code",
      overrides: {
        target_code: null,
        fix_plan: [
          { step: 1, action: "edit", file: "src/a.ts", description: "Re-export the type" },
          { step: 2, action: "move", description: "Relocate the helper" },
        ],
      },
      contains: ["  Has target_code: False", "  Has fix_plan: True", "  3. Execute fix_plan (2 steps):", "     Step 1: edit src/a.ts -- Re-export the type", "     Step 2: move  -- Relocate the helper"],
    },
    { name: "neither target code nor plan leaves the fix to the explanation", overrides: { target_code: null }, contains: ["  3. Read explanation and write appropriate fix"] },
    {
      name: "long target code and explanation are cut at two and three hundred characters",
      overrides: { target_code: "t".repeat(250), explanation: "e".repeat(350) },
      contains: [`     TARGET: ${"t".repeat(200)}\n`, `  EXPLANATION: ${"e".repeat(300)}\n`],
    },
  ])("$name", ({ stack, overrides, contains }) => {
    const project = makeProject({ phases: { 0: [task("BLD-001", overrides)] }, ...(stack === undefined ? {} : { stack }) });

    const { output, code } = run(project);

    expect(code).toBe(0);
    for (const text of contains) expect(output).toContain(text);
  });
});

interface OrderCase {
  name: string;
  tasks: Task[];
  order: string[];
  reordered: boolean;
}

describe("runPipeline task order", () => {
  it.each<OrderCase>([
    {
      name: "ascending same-file tasks are reordered bottom-up in place, other slots untouched",
      tasks: [task("A-1", { file: "src/app.ts", line: 10 }), done("X-1"), task("A-2", { file: "src/app.ts", line: 50 })],
      order: ["A-2", "X-1", "A-1"],
      reordered: true,
    },
    {
      name: "tasks already bottom-up stay as they are",
      tasks: [task("A-1", { file: "src/app.ts", line: 50 }), task("A-2", { file: "src/app.ts", line: 10 })],
      order: ["A-1", "A-2"],
      reordered: false,
    },
  ])("$name", ({ tasks, order, reordered }) => {
    const project = makeProject({ phases: { 0: tasks } });

    const { output } = run(project);

    expect(savedTasks(project).map((saved) => saved["id"])).toEqual(order);
    expect(output.includes("  AUTO_REORDERED: src/app.ts (same-file tasks now bottom-up)\n")).toBe(reordered);
    expect(output).toContain(`NEXT_TASK: index=${order.findIndex((id) => id !== "X-1")} id=${order.find((id) => id !== "X-1")}`);
  });
});

const low = (id: string, overrides: Task = {}): Task =>
  task(id, { confidence: "low", rule: "R04", description: `desc ${id}`, confidence_reason: "why", file: `src/${id}.ts`, target_code: "x", ...overrides });
const DECISIONS_FILE = "docs/audit/data/human-decisions.json";

interface DecisionCase {
  name: string;
  tasks: Task[];
  decisions?: string;
  contains: string[];
  absent?: string[];
  after?: Record<string, Task>;
}

describe("runPipeline low-confidence decisions", () => {
  it.each<DecisionCase>([
    {
      name: "an individually approved LOW fix is handed out as the task",
      tasks: [low("LOW-001")],
      decisions: JSON.stringify({ decided_ids: { "LOW-001": "fix" } }),
      contains: ["NEXT_TASK: index=0 id=LOW-001"],
      absent: ["LOW-CONFIDENCE REVIEW:"],
      after: { "LOW-001": { status: "pending" } },
    },
    {
      name: "a bulk fix decision queues its LOW tasks after the auto-fix ones",
      tasks: [low("L-1"), task("H-1")],
      decisions: JSON.stringify({ bulk_rules: { R04: "fix-all-low" } }),
      contains: ["NEXT_TASK: index=1 id=H-1", "Pending: 2"],
    },
    {
      name: "an individual skip completes the task with a note",
      tasks: [low("L-1"), task("H-1")],
      decisions: JSON.stringify({ decided_ids: { "L-1": "skip" } }),
      contains: ["id=H-1"],
      after: { "L-1": { status: "completed", resolution: "skipped", notes: "Skipped by human decision" } },
    },
    {
      name: "a bulk skip names the rule in its note",
      tasks: [low("L-1"), task("H-1")],
      decisions: JSON.stringify({ bulk_rules: { R04: "skip-all-low" } }),
      contains: ["id=H-1"],
      after: { "L-1": { status: "completed", resolution: "skipped", notes: "Skipped by bulk decision: skip-all-R04-LOW" } },
    },
    {
      name: "undecided LOW tasks wait while auto-fix tasks go first",
      tasks: [low("L-1"), task("H-1")],
      contains: ["id=H-1", "Pending: 1"],
      absent: ["LOW-CONFIDENCE REVIEW:"],
      after: { "L-1": { status: "pending" } },
    },
    {
      name: "when every LOW is skipped and nothing else is left the run asks for another run instead of failing",
      tasks: [low("L-1")],
      decisions: JSON.stringify({ decided_ids: { "L-1": "skip" } }),
      contains: ["Run this script again for the next task."],
      absent: ["NEXT_TASK", "LOW-CONFIDENCE REVIEW:"],
      after: { "L-1": { status: "completed", resolution: "skipped" } },
    },
    {
      name: "an unreadable decisions file is reported and ignored",
      tasks: [low("L-1")],
      decisions: "{not json",
      contains: ["  WARNING: Failed to parse human-decisions.json (", "LOW-CONFIDENCE REVIEW: 1 findings need your input"],
    },
    {
      name: "a decisions file that is not an object is reported and ignored",
      tasks: [low("L-1")],
      decisions: "[]",
      contains: ["  WARNING: human-decisions.json is not a dict. Ignoring.\n", "LOW-CONFIDENCE REVIEW: 1 findings need your input"],
    },
  ])("$name", ({ tasks, decisions, contains, absent, after }) => {
    const project = makeProject({ phases: { 0: tasks }, files: decisions === undefined ? {} : { [DECISIONS_FILE]: decisions } });

    const { output, code } = run(project);

    expect(code).toBe(0);
    for (const text of contains) expect(output).toContain(text);
    for (const text of absent ?? []) expect(output).not.toContain(text);
    for (const [id, fields] of Object.entries(after ?? {})) expect(savedTasks(project).find((saved) => saved["id"] === id)).toMatchObject(fields);
  });

  it("asks for decisions on undecided LOW findings when nothing else can be fixed", () => {
    const project = makeProject({ phases: { 0: [low("L-1", { line: 5 }), low("L-2", { target_code: null, confidence_reason: undefined })] } });
    const rule = "=".repeat(60);

    const { output, code } = run(project);

    expect(code).toBe(0);
    expect(output.slice(output.indexOf(`\n${rule}\n`))).toBe(
      [
        "",
        rule,
        "LOW-CONFIDENCE REVIEW: 2 findings need your input",
        rule,
        "",
        "[1/2] L-1 [R04] src/L-1.ts:5",
        "  desc L-1",
        "  Confidence: LOW — why",
        "  Fix: x",
        "",
        "[2/2] L-2 [R04] src/L-2.ts:10",
        "  desc L-2",
        "  Confidence: LOW — no reason given",
        "",
        "ACTION: Review LOW-confidence findings and record decisions.",
        `  Write to: ${project}/docs/audit/data/human-decisions.json`,
        '  Format: {"decided_ids": {"FINDING-ID": "fix|skip"}, "bulk_rules": {"R04": "skip-all-low"}}',
        "  Then run this script again to apply decisions and continue.",
        "",
      ].join("\n"),
    );
  });

  it("lists at most fifteen undecided findings and counts the rest", () => {
    const project = makeProject({ phases: { 0: Array.from({ length: 16 }, (_, index) => low(`L-${index}`)) } });

    const { output } = run(project);

    expect(output).toContain("[15/16] L-14 [R04]");
    expect(output).not.toContain("[16/16]");
    expect(output).toContain("  ... and 1 more\n\n");
  });
});

interface ValidationCase {
  name: string;
  task: Task;
  source?: string;
  contains: string[];
  absent?: string[];
  after: Task;
}

describe("runPipeline next-task checks", () => {
  it.each<ValidationCase>([
    {
      name: "a task whose code is gone is skipped with the reason and left resolved",
      task: { current_code: "legacyCall(msg);", line: 4 },
      source: SOURCE,
      contains: ["  TASK_SKIPPED: BLD-001 — code no longer present (fixed by earlier phase)\n  Run this script again for the next task.\n"],
      absent: ["ACTION: Fix this violation."],
      after: { status: "completed", resolution: "already_resolved" },
    },
    {
      name: "a task whose code moved far is skipped once, with its line updated for the next run",
      task: { current_code: "console.log(msg);", line: 4 },
      source: [...filler(54), "console.log(msg);"].join("\n"),
      contains: ["  TASK_SKIPPED: BLD-001"],
      absent: ["ACTION: Fix this violation."],
      after: { status: "pending", line: 55, line_shifted: true },
    },
    {
      name: "a task whose code moved a little is handed out with its new line, which the phase file does not keep",
      task: { current_code: "console.log(msg);", line: 2 },
      source: SOURCE,
      contains: ["  File: src/app.ts:4\n", "NEXT_TASK: index=0 id=BLD-001"],
      after: { status: "pending", line: 2 },
    },
    {
      name: "a task that cannot be validated is warned about and handed out as it is",
      task: { current_code: "console.log(msg);", line: "four" },
      source: SOURCE,
      contains: ["  WARNING: Task revalidation failed (", "). Proceeding with unvalidated task.\n", "NEXT_TASK: index=0 id=BLD-001"],
      after: { status: "pending" },
    },
    {
      name: "a fix plan that deletes a file is skipped for the operator to approve and never handed out",
      task: {
        target_code: null,
        fix_plan: [
          { step: 1, action: "edit", file: "src/a.ts", description: "Re-export" },
          { step: 2, action: "delete", file: "src/legacy-user.ts", description: "Remove duplicate" },
          { step: 3, action: "delete", file: "src/old.ts", description: "Remove another" },
        ],
      },
      contains: ["  TASK_SKIPPED: BLD-001 — fix_plan deletes src/legacy-user.ts, src/old.ts; needs operator approval\n  Run this script again for the next task.\n"],
      absent: ["ACTION: Fix this violation."],
      after: { status: "skipped", resolution: "skipped", notes: "delete needs operator approval: src/legacy-user.ts, src/old.ts" },
    },
  ])("$name", ({ task: overrides, source, contains, absent, after }) => {
    const project = makeProject({ phases: { 0: [task("BLD-001", overrides)] }, files: source === undefined ? {} : { "src/app.ts": source } });

    const { output, code } = run(project);

    expect(code).toBe(0);
    for (const text of contains) expect(output).toContain(text);
    for (const text of absent ?? []) expect(output).not.toContain(text);
    expect(savedTasks(project)[0]).toMatchObject(after);
  });
});

const RASENGAN_CLI = join(SKILL_DIR, "scripts", "run-pipeline.ts");
const RASENGAN_USAGE = "usage: rasengan [-h] [--phase PHASE] project_dir";

interface CliCase {
  name: string;
  argv: (project: string) => string[];
  status: number;
  stdout?: string[];
  stderr?: (project: string) => string;
}

describe("rasengan run-pipeline CLI", () => {
  it.each<CliCase>([
    { name: "hands out the first task for a project directory", argv: (project) => [project], status: 0, stdout: ["NEXT_TASK: index=0 id=BLD-001"] },
    { name: "--phase limits the run to that phase", argv: (project) => [project, "--phase", "0"], status: 0, stdout: ["NEXT_TASK: index=0 id=BLD-001"] },
    { name: "--phase for a phase with nothing pending reports PHASE_COMPLETE", argv: (project) => [project, "--phase", "3"], status: 0, stdout: ["PHASE_COMPLETE: 3"] },
    { name: "a missing project directory is a usage error", argv: () => [], status: 2, stderr: () => `${RASENGAN_USAGE}\nrasengan: error: the following arguments are required: project_dir\n` },
    { name: "a non-integer phase is a usage error", argv: (project) => [project, "--phase", "x"], status: 2, stderr: () => `${RASENGAN_USAGE}\nrasengan: error: argument --phase: invalid int value: 'x'\n` },
    { name: "a project without task files exits 1 with the error on stdout", argv: () => ["/nonexistent-project"], status: 1, stdout: ["ERROR: No task files found. Run /rinnegan first."] },
  ])("$name", ({ argv, status, stdout, stderr }) => {
    const project = makeProject();

    const result = Bun.spawnSync([process.execPath, RASENGAN_CLI, ...argv(project)], { stdout: "pipe", stderr: "pipe" });

    expect(result.exitCode).toBe(status);
    for (const text of stdout ?? []) expect(result.stdout.toString()).toContain(text);
    if (stderr !== undefined) expect(result.stderr.toString()).toBe(stderr(project));
  });
});

function gitIn(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const stale = (id: string, file: string): Task => task(id, { file, current_code: "legacyCall(msg);", line: 4 });
const scopedPhases = (): Record<number, Task[]> => ({ 0: [stale("P0-A", "src/a.ts"), stale("P0-B", "src/b.ts")], 1: [stale("P1-A", "src/a.ts")] });
const scopedFiles = { "src/a.ts": SOURCE, "src/b.ts": SOURCE };

interface ScopeCase {
  name: string;
  options: { phaseNum?: number; taskId?: string; changedOnly?: boolean };
  changeB?: boolean;
  stats: Partial<typeof NO_STATS> & { error?: string };
  resolved: string[];
}

describe("revalidateAll scope", () => {
  it.each<ScopeCase>([
    { name: "all phases when nothing narrows it", options: {}, stats: { already_resolved: 3 }, resolved: ["P0-A", "P0-B", "P1-A"] },
    { name: "only the selected phase", options: { phaseNum: 1 }, stats: { already_resolved: 1 }, resolved: ["P1-A"] },
    { name: "only the selected task, the rest counted as skipped", options: { taskId: "P0-B" }, stats: { already_resolved: 1, skipped: 2 }, resolved: ["P0-B"] },
    { name: "only tasks in files changed since HEAD~1", options: { changedOnly: true }, changeB: true, stats: { already_resolved: 1, skipped: 2 }, resolved: ["P0-B"] },
    { name: "changed-only with no previous commit skips everything", options: { changedOnly: true }, stats: { skipped: 3 }, resolved: [] },
  ])("$name", ({ options, changeB, stats, resolved }) => {
    const project = makeProject({ phases: scopedPhases(), files: scopedFiles });
    if (options.changedOnly === true) {
      gitIn(project, "init", "-q");
      gitIn(project, "add", "-A");
      gitIn(project, "commit", "-q", "-m", "audit");
      if (changeB === true) {
        writeFileSync(join(project, "src/b.ts"), `${SOURCE}\n// edited\n`);
        gitIn(project, "commit", "-q", "-a", "-m", "edit b");
      }
    }

    expect(revalidateAll(project, options)).toEqual({ ...NO_STATS, ...stats });

    const ids = [0, 1].flatMap((phase) => savedTasks(project, phase)).filter((saved) => saved["status"] === "completed").map((saved) => saved["id"]);
    expect(ids).toEqual(resolved);
  });

  it("reports a project without task files", () => {
    expect(revalidateAll(projectFiles({ ".keep": "" }))).toEqual({ ...NO_STATS, error: "No task files found" });
  });
});

describe("revalidate-tasks CLI", () => {
  it("prints the options in force, the phases with activity and the totals", () => {
    const project = makeProject({ phases: scopedPhases(), files: scopedFiles });

    const result = Bun.spawnSync([process.execPath, join(SKILL_DIR, "..", "rinnegan", "scripts", "revalidate-tasks.ts"), project, "--phase", "0"], { stdout: "pipe", stderr: "pipe" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      [
        `Revalidating tasks in ${project}`,
        "  Phase: 0",
        "  Phase 0: {'already_resolved': 2}",
        "",
        "Results:",
        "  Valid (no change):     0",
        "  Line updated:         0",
        "  Already resolved:     2",
        "  Needs rescan:         0",
        "  Skipped (done/other): 0",
        "",
        "  2 tasks removed (already fixed by earlier phases)",
        "",
      ].join("\n"),
    );
  });
});

describe("runPipeline dispatch record", () => {
  it("appends one dispatch line for the task it hands out and none when it hands out nothing", () => {
    const handedOut = makeProject();
    const nothing = makeProject({ phases: { 0: [done("A-1")] } });

    run(handedOut);
    run(nothing);

    expect(readFileSync(join(handedOut, "docs/audit/data/dispatch-log.jsonl"), "utf8")).toMatch(/^\{"task": "fix_BLD-001", "tokens": 5000, "model": "sonnet", "timestamp": "[^"]+"\}\n$/);
    expect(existsSync(join(nothing, "docs/audit/data/dispatch-log.jsonl"))).toBe(false);
  });
});
