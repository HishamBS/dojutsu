import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";

const SCANNER = join(import.meta.dir, "..", "..", "..", "violation_scanner.ts");
const FOUND = "❌ VIOLATIONS FOUND:";
const CLEAN = "✅ ZERO violations detected";

function scan(args: string[]): { status: number | null; stdout: string } {
  const result = Bun.spawnSync([process.execPath, SCANNER, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

const SAMPLE = [
  "try:",
  "    pass",
  "except:",
  "    time.sleep(5)",
  "assert r.status_code == 200",
  "def f(x: Any[int]): pass",
  "y: any = 1  # type-ignore",
  "z: any = 1",
  'version = "1.2.3"',
  "timeout = 30  # ML",
  "",
].join("\n");

describe("violation scanner CLI", () => {
  it("lists each rule's hits with file, line and the stripped line, in rule order, and exits 1", () => {
    const dir = projectFiles({ 'my "sample" file.py': SAMPLE });
    const file = join(dir, 'my "sample" file.py');

    const { status, stdout } = scan([file]);

    expect(status).toBe(1);
    expect(stdout).toBe(
      [
        FOUND,
        "",
        "R09_bare_except:",
        `  ${file}:3 - except:`,
        "",
        "R13_magic_numbers:",
        `  ${file}:4 - time.sleep(5)`,
        `  ${file}:5 - assert r.status_code == 200`,
        "",
        "R07_any_type:",
        `  ${file}:6 - def f(x: Any[int]): pass`,
        `  ${file}:8 - z: any = 1`,
        "",
        "R13_hardcoded_versions:",
        `  ${file}:9 - version = "1.2.3"`,
        "",
        "",
      ].join("\n"),
    );
  });

  it("scans several files in argument order, skips missing ones and cuts long lines at 80 characters", () => {
    const dir = projectFiles({ "a.ts": `const x: any = "${"a".repeat(100)}";\n`, "b.ts": "ok\n" });

    const { status, stdout } = scan([join(dir, "b.ts"), join(dir, "missing.ts"), join(dir, "a.ts")]);

    expect(status).toBe(1);
    expect(stdout).toBe(`${FOUND}\n\nR07_any_type:\n  ${join(dir, "a.ts")}:1 - ${`const x: any = "${"a".repeat(100)}";`.slice(0, 80)}\n\n`);
  });

  it("reports zero violations with exit 0 and a usage line without arguments", () => {
    const dir = projectFiles({ "clean.ts": "export const x = 1;\n" });

    expect(scan([join(dir, "clean.ts")])).toEqual({ status: 0, stdout: `${CLEAN}\n` });
    expect(scan([])).toEqual({ status: 1, stdout: "Usage: bun violation_scanner.ts <file1> <file2> ...\n" });
  });
});

const SKILL_DIR = join(import.meta.dir, "..");
const ODD_NAME = "my \"phase\" 'tasks' $HOME `x`.json";

function runShell(script: string, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const path = `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`;
  const result = Bun.spawnSync(["bash", join(SKILL_DIR, script), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path, ...env } });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const phaseJson = (verification: unknown): string => JSON.stringify({ phase: 1, verification });

interface VerifyCase {
  name: string;
  files: Record<string, string>;
  stdout: (file: string) => string;
  status: number;
}

describe("verify-phase.sh", () => {
  it.each<VerifyCase>([
    { name: "a command whose output matches is a PASS", files: { [ODD_NAME]: phaseJson({ command: "echo ok", expected: "ok" }) }, status: 0, stdout: () => "Running: echo ok\nPASS: Expected 'ok', got 'ok'\n" },
    {
      name: "whitespace is ignored on both sides",
      files: { [ODD_NAME]: phaseJson({ command: 'printf "a  b\\n c"', expected: "a b c" }) },
      status: 0,
      stdout: () => 'Running: printf "a  b\\n c"\nPASS: Expected \'a b c\', got \'abc\'\n',
    },
    { name: "stderr is part of the output", files: { [ODD_NAME]: phaseJson({ command: "echo out; echo err >&2", expected: "outerr" }) }, status: 0, stdout: () => "Running: echo out; echo err >&2\nPASS: Expected 'outerr', got 'outerr'\n" },
    { name: "a different output is a FAIL", files: { [ODD_NAME]: phaseJson({ command: "echo no", expected: "yes" }) }, status: 1, stdout: () => "Running: echo no\nFAIL: Expected 'yes', got 'no'\n" },
    { name: "a command that exits non-zero stops the script with its exit status", files: { [ODD_NAME]: phaseJson({ command: "echo x; exit 3", expected: "x" }) }, status: 3, stdout: () => "Running: echo x; exit 3\n" },
    { name: "no verification command is only a warning", files: { [ODD_NAME]: "{}" }, status: 0, stdout: (file) => `WARN: No verification command in ${file}\n` },
    { name: "a missing file fails", files: {}, status: 1, stdout: (file) => `FAIL: ${file} not found\n` },
    { name: "malformed JSON stops the script without output", files: { [ODD_NAME]: "{bad" }, status: 1, stdout: () => "" },
    { name: "a verification that is not an object stops the script without output", files: { [ODD_NAME]: phaseJson("str") }, status: 1, stdout: () => "" },
  ])("$name", ({ files, stdout, status }) => {
    const dir = projectFiles({ ".keep": "", ...files });
    const file = join(dir, ODD_NAME);

    const result = runShell("verify-phase.sh", [file]);

    expect([result.status, result.stdout]).toEqual([status, stdout(file)]);
  });

  it("needs its argument and a bun to run on", () => {
    expect(runShell("verify-phase.sh", []).stderr).toContain("Usage: verify-phase.sh <phase_tasks_json>");
    const noBun = runShell("verify-phase.sh", ["x.json"], { PATH: "/usr/bin:/bin" });
    expect([noBun.status, noBun.stderr]).toEqual([1, "verify-phase.sh: bun is required -- install it from https://bun.sh, then re-run\n"]);
  });
});

const AUDIT_NAME = "my \"audit\" 'dir' $HOME";
const TASKS = `${AUDIT_NAME}/data/tasks`;
const TABLE_HEADER = [
  "Phase | Total | Pending | InProgress | Completed | Resolved | Skipped | Failed",
  "------|-------|---------|------------|-----------|----------|---------|-------",
];
const phaseTasks = (phase: number, tasks: unknown[]): string => JSON.stringify({ phase, tasks });

describe("track-progress.sh", () => {
  it("prints one row per phase file in glob order and the resolved total", () => {
    const dir = projectFiles({
      [`${TASKS}/phase-0-tasks.json`]: phaseTasks(0, [
        { status: "completed", resolution: "applied" },
        { status: "completed", resolution: "already_resolved" },
        { status: "pending" },
        { status: "in_progress" },
        { status: "completed", resolution: "skipped" },
        { status: "completed", resolution: "failed" },
        { status: "completed", resolution: "line-shifted" },
      ]),
      [`${TASKS}/phase-10-tasks.json`]: phaseTasks(10, [{ status: "pending" }]),
      [`${TASKS}/phase-2-tasks.json`]: phaseTasks(2, []),
      [`${TASKS}/phase-3-tasks.json`]: "{bad",
      [`${TASKS}/phase-4-tasks.json`]: JSON.stringify({ phase: 4 }),
      [`${TASKS}/phase-5-tasks.json`]: phaseTasks(5, [{ status: "pending" }, "not a task"]),
    });

    const { status, stdout } = runShell("track-progress.sh", [join(dir, AUDIT_NAME)]);

    expect(status).toBe(0);
    expect(stdout).toBe(
      [
        ...TABLE_HEADER,
        "  0     | 7     | 1       | 1          | 5         | 1        | 1       | 1",
        "  10    | 1     | 1       | 0          | 0         | 0        | 0       | 0",
        "  2     | 0     | 0       | 0          | 0         | 0        | 0       | 0",
        "  3     | 0     | 0       | 0          | 0         | 0        | 0       | 0",
        "  4     | 0     | 0       | 0          | 0         | 0        | 0       | 0",
        "  5     | 0     | 0       | 0          | 0         | 0        | 0       | 0",
        "",
        "Total: 6/8 tasks resolved",
        "",
      ].join("\n"),
    );
  });

  it("prints just the header and zero totals for an empty tasks directory, and fails without one", () => {
    const empty = projectFiles({ [`${TASKS}/.keep`]: "" });

    expect(runShell("track-progress.sh", [join(empty, AUDIT_NAME)]).stdout).toBe([...TABLE_HEADER, "", "Total: 0/0 tasks resolved", ""].join("\n"));
    const missing = runShell("track-progress.sh", [join(empty, "nowhere")]);
    expect([missing.status, missing.stdout]).toEqual([1, `No tasks directory at ${join(empty, "nowhere")}/data/tasks\n`]);
  });
});

const resolutions = (...values: (string | null)[]): unknown[] => values.map((resolution) => (resolution === null ? {} : { resolution }));
const phaseFile = (fields: Record<string, unknown>): string => JSON.stringify(fields);

interface MessageCase {
  name: string;
  json: string | null;
  message: string;
}

describe("generate-commit-message.sh", () => {
  it.each<MessageCase>([
    { name: "one applied fix", json: phaseFile({ phase: 2, phase_name: "Typing", tasks: resolutions("applied") }), message: "fix(phase-2): Typing - 1 applied" },
    {
      name: "every resolution in a fixed order, tasks without one ignored",
      json: phaseFile({ phase: 2, phase_name: "Typing", tasks: resolutions("applied", "applied", "line-shifted", "already_resolved", "skipped", "failed", null) }),
      message: "fix(phase-2): Typing - 2 applied, 1 line-shifted, 1 already-resolved, 1 skipped, 1 failed",
    },
    { name: "no tasks", json: phaseFile({ phase: 2, phase_name: "Typing", tasks: [] }), message: "fix(phase-2): Typing - no changes" },
    { name: "a null phase and name print as None", json: phaseFile({ phase: null, phase_name: null, tasks: resolutions("applied") }), message: "fix(phase-None): None - 1 applied" },
    { name: "a non-ASCII name", json: phaseFile({ phase: "?", phase_name: "é", tasks: [] }), message: "fix(phase-?): é - no changes" },
    { name: "a missing required field is malformed", json: phaseFile({ phase_name: "Typing", tasks: [] }), message: "fix: phase completion (malformed JSON)" },
    { name: "invalid JSON is malformed", json: "{bad", message: "fix: phase completion (malformed JSON)" },
    { name: "JSON that is not an object is malformed", json: "[]", message: "fix: phase completion (malformed JSON)" },
    { name: "tasks that are not objects cannot be counted", json: phaseFile({ phase: 2, phase_name: "T", tasks: ["x"] }), message: "fix: phase completion" },
    { name: "a missing file", json: null, message: "fix: phase completion" },
  ])("$name gives $message", ({ json, message }) => {
    const dir = projectFiles({ ".keep": "", ...(json === null ? {} : { [ODD_NAME]: json }) });

    const result = runShell("generate-commit-message.sh", [join(dir, ODD_NAME)]);

    expect([result.status, result.stdout]).toEqual([0, `${message}\n`]);
  });
});

describe("rasengan shell entrypoints without their prerequisites", () => {
  it.each([
    { script: "track-progress.sh", usage: "Usage: track-progress.sh <audit_dir>" },
    { script: "generate-commit-message.sh", usage: "Usage: generate-commit-message.sh <phase_tasks_json>" },
  ])("$script wants an argument and a bun to run on", ({ script, usage }) => {
    expect(runShell(script, []).stderr).toContain(usage);
    const noBun = runShell(script, ["x"], { PATH: "/usr/bin:/bin" });
    expect([noBun.status, noBun.stderr]).toEqual([1, `${script}: bun is required -- install it from https://bun.sh, then re-run\n`]);
  });
});
