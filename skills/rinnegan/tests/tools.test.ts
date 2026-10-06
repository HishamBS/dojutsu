import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printing, startRegistry, withToolEnvironment, writeExecutable } from "@quality-test/fake-tools.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { detectTools, runTool, runToolSafe } from "@rinnegan/tool_runner.ts";

type Row = [file: string, line: number, rule: string, category: string, severity: string, toolRuleId: string];

interface Fakes {
  bin?: Record<string, string>;
  local?: Record<string, string>;
}

interface ToolCase {
  name: string;
  tool: string;
  stack?: string;
  files?: Record<string, string>;
  fakes: (dir: string) => Fakes;
  options?: { retryDelayMs?: number; timeoutMs?: number };
  status: "success" | "skipped" | "failed" | "timeout";
  rows?: Row[];
  error?: string;
  viaRunTool?: boolean;
  snippets?: string[];
  confidences?: string[];
  forbidden?: string;
  afterRun?: (dir: string) => void;
  registry?: object;
  registryStatus?: number;
}

// The project directory carries a space and a quote: every path must travel as argv data.
const PROJECT_DIR_NAME = "it's a project";
const NO_RETRY_DELAY_MS = 0;
// Long enough for a fake to start and record its report path under load, well short of the fake's 5s sleep.
const FAKE_START_TIMEOUT_MS = 2000;
const tools = (rows: Row[], status: ToolCase["status"] = "success"): Pick<ToolCase, "rows" | "status"> => ({ rows, status });

// A fake that prints `output` only when invoked with exactly these leading arguments.
function whenInvoked(args: string[], output: string): string {
  const test = args.map((arg, index) => `[ "$${index + 1}" = "${arg}" ]`).join(" && ");
  return `if ${test}; then\n${printing(output)}else\necho "unexpected arguments: $*" >&2\nexit 2\nfi\n`;
}

const eslintOutput = (dir: string, messages: object[]): string => JSON.stringify([{ filePath: join(dir, "src", "app.tsx"), messages }]);
const eslintFake = (dir: string, messages: object[]): Fakes => ({ local: { eslint: whenInvoked(["--format", "json", "src/"], eslintOutput(dir, messages)) } });

const semgrepResult = (id: string, path: string, line: number, extra: object): object => ({ check_id: id, path, start: { line }, extra });
const SEMGREP_ARGS_FAKE = `cat <<EOF\n{"results":[{"check_id":"$*","path":"app.py","start":{"line":5},"extra":{"severity":"ERROR","message":"injection","lines":"eval(x)","metadata":{"cwe":"CWE-94","category":"security"}}}]}\nEOF\n`;
const semgrepRows = (args: string): Row[] => [["app.py", 5, "R05", "security", "HIGH", args]];

const CHECKSTYLE_XML = (dir: string): string =>
  `<checkstyle version="10"><file name="${join(dir, "src", "Main.java")}">` +
  '<error line="3" severity="error" message="Missing a Javadoc comment." source="com.puppycrawl.tools.checkstyle.checks.javadoc.MissingJavadocMethodCheck"/>' +
  '<error line="7" severity="warning" message="Line is longer than 100 characters." source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck"/>' +
  "</file></checkstyle>";

const FLAKY_ESLINT = (dir: string): string =>
  `if [ -f "$0.ran" ]; then\n${printing(eslintOutput(dir, [{ ruleId: "no-console", message: "Unexpected console statement.", line: 3 }]))}else\ntouch "$0.ran"\necho "transient garbage"\nfi\n`;

const JSCPD_REPORT = JSON.stringify({
  duplicates: [
    { lines: 25, firstFile: { name: "src/a.ts", start: 3 }, secondFile: { name: "src/b.ts", start: 10 } },
    { lines: 6, firstFile: { name: "src/c.ts", start: 1 }, secondFile: { name: "src/d.ts", start: 2 } },
  ],
});
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const GITLEAKS_REPORT = JSON.stringify([
  { File: "src/config.ts", StartLine: 12, EndLine: 12, Description: "AWS Access Key", RuleID: "aws-access-token", Secret: SECRET, Match: `key = ${SECRET}` },
]);
const BUN_LOCK_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { lodash: "4.17.20", minimist: "1.2.5" } }),
  "bun.lock": JSON.stringify({
    lockfileVersion: 1,
    workspaces: { "": { name: "fixture", dependencies: { lodash: "4.17.20", minimist: "1.2.5" } } },
    packages: { lodash: ["lodash@4.17.20", "", {}, "sha512-fixture"], minimist: ["minimist@1.2.5", "", {}, "sha512-fixture"] },
  }),
};

// A jscpd that, when asked to scan `root`, notes its report directory and writes a report there.
const jscpdFake = (dir: string, root: string): string =>
  `[ "$1" = "${root}" ] && [ "$8" = "--output" ] || exit 2\necho "$9" > "${join(dir, "report-path.txt")}"\n${printing(JSCPD_REPORT).replace("cat <<'FAKE_TOOL_EOF'", `cat > "$9/jscpd-report.json" <<'FAKE_TOOL_EOF'`)}`;

// A gitleaks that notes where it was told to write its report, then writes `report` there.
const gitleaksFake = (dir: string, report: string): string =>
  `echo "$8" > "${join(dir, "report-path.txt")}"\n${printing(report).replace("cat <<'FAKE_TOOL_EOF'", `cat > "$8" <<'FAKE_TOOL_EOF'`)}`;

// The report path a fake tool recorded must be gone once the run is over.
function expectRecordedReportRemoved(dir: string): void {
  const recorded = readFileSync(join(dir, "report-path.txt"), "utf8").trim();
  expect(recorded).not.toBe("");
  expect(existsSync(recorded)).toBe(false);
}

describe("runToolSafe", () => {
  it.each<ToolCase>([
    {
      name: "eslint: rule mapping, wildcard prefix, default and parse errors, paths made relative",
      tool: "eslint",
      fakes: (dir) =>
        eslintFake(dir, [
          { ruleId: "no-unused-vars", message: "'x' is assigned but never used.", line: 5 },
          { ruleId: "no-console", message: "Unexpected console statement.", line: 3 },
          { ruleId: "@typescript-eslint/no-explicit-any", message: "Unexpected any.", line: 7 },
          { ruleId: "jsx-a11y/alt-text", message: "img needs alt", line: 9 },
          { ruleId: "some-custom-rule", message: "custom", line: 11 },
          { ruleId: null, message: "Parsing error: x", line: 1 },
        ]),
      ...tools([
        ["src/app.tsx", 5, "R14", "build", "MEDIUM", "no-unused-vars"],
        ["src/app.tsx", 3, "R09", "clean-code", "MEDIUM", "no-console"],
        ["src/app.tsx", 7, "R07", "typing", "HIGH", "@typescript-eslint/no-explicit-any"],
        ["src/app.tsx", 9, "R16", "full-stack", "MEDIUM", "jsx-a11y/alt-text"],
        ["src/app.tsx", 11, "R14", "build", "MEDIUM", "some-custom-rule"],
        ["src/app.tsx", 1, "R14", "build", "MEDIUM", "parse-error"],
      ]),
    },
    { name: "eslint: empty output is a clean success", tool: "eslint", fakes: () => ({ local: { eslint: "exit 1\n" } }), ...tools([]) },
    {
      name: "tsc: type errors are typing, others build, warnings medium, noise ignored",
      tool: "tsc",
      fakes: () => ({
        local: {
          tsc: whenInvoked(
            ["--noEmit", "--pretty", "false"],
            [
              "src/utils.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
              "src/index.ts(3,1): error TS1005: ';' expected.",
              "src/w.ts(2,2): warning TS6133: 'a' is declared but never used.",
              "Found 3 errors in 3 files.",
            ].join("\n"),
          ),
        },
      }),
      ...tools([
        ["src/utils.ts", 12, "R07", "typing", "HIGH", "TS2322"],
        ["src/index.ts", 3, "R14", "build", "HIGH", "TS1005"],
        ["src/w.ts", 2, "R14", "build", "MEDIUM", "TS6133"],
      ]),
    },
    {
      name: "ruff: mapped, default and security codes with absolute filenames made relative",
      tool: "ruff",
      stack: "python",
      fakes: (dir) => ({
        bin: {
          ruff: whenInvoked(
            ["check", "--output-format", "json", "."],
            JSON.stringify([
              { code: "F401", message: "`os` imported but unused", filename: join(dir, "app", "main.py"), location: { row: 1, column: 1 } },
              { code: "S608", message: "Possible SQL injection", filename: join(dir, "db.py"), location: { row: 10, column: 1 } },
              { code: "ZZZZ999", message: "Unknown rule", filename: join(dir, "x.py"), location: { row: 2, column: 1 } },
            ]),
          ),
        },
      }),
      ...tools([
        ["app/main.py", 1, "R14", "build", "LOW", "F401"],
        ["db.py", 10, "R05", "security", "HIGH", "S608"],
        ["x.py", 2, "R14", "build", "LOW", "ZZZZ999"],
      ]),
    },
    {
      name: "mypy: errors mapped, notes and unparsable lines skipped, paths kept as reported",
      tool: "mypy",
      stack: "python",
      fakes: () => ({
        bin: {
          mypy: whenInvoked(
            ["--output", "json"],
            [
              JSON.stringify({ file: "app/service.py", line: 25, message: "Incompatible types in assignment", severity: "error", code: "assignment" }),
              JSON.stringify({ file: "a.py", line: 1, message: "See definition", severity: "note", code: "" }),
              "not valid json",
              JSON.stringify({ file: "b.py", line: 5, message: "Name missing", severity: "error", code: "name-defined" }),
              JSON.stringify({ file: "c.py", line: 9, message: "Other", severity: "error", code: "" }),
            ].join("\n"),
          ),
        },
      }),
      ...tools([
        ["app/service.py", 25, "R07", "typing", "MEDIUM", "assignment"],
        ["b.py", 5, "R14", "build", "HIGH", "name-defined"],
        ["c.py", 9, "R07", "typing", "MEDIUM", ""],
      ]),
    },
    ...(["python", "typescript", "java", "go"] as const).map(
      (stack): ToolCase => ({
        name: `semgrep: ${stack} selects its rule sets`,
        tool: "semgrep",
        stack,
        fakes: () => ({ bin: { semgrep: SEMGREP_ARGS_FAKE } }),
        ...tools(
          semgrepRows(
            {
              python: "--json --quiet --config p/python --config p/security-audit .",
              typescript: "--json --quiet --config p/typescript --config p/security-audit .",
              java: "--json --quiet --config p/java --config p/security-audit .",
              go: "--json --quiet --config auto .",
            }[stack],
          ),
        ),
      }),
    ),
    {
      name: "semgrep: severity and category decide the rule, unknown severities are low",
      tool: "semgrep",
      stack: "python",
      fakes: () => ({
        bin: {
          semgrep: printing(
            JSON.stringify({
              results: [
                semgrepResult("rule.a", "a.py", 1, { severity: "WARNING", message: "m", lines: "x", metadata: { category: "correctness" } }),
                semgrepResult("rule.b", "b.py", 2, { severity: "CRITICAL", message: "m", lines: "y", metadata: { category: "Security", cwe: ["CWE-1", "CWE-2"] } }),
              ],
            }),
          ),
        },
      }),
      ...tools([
        ["a.py", 1, "R14", "build", "MEDIUM", "rule.a"],
        ["b.py", 2, "R05", "security", "LOW", "rule.b"],
      ]),
    },
    {
      name: "checkstyle: javadoc sources are documentation findings, severity decides the level",
      tool: "checkstyle",
      stack: "java",
      files: { "tools/checkstyle.jar": "jar", "src/Main.java": "class Main {}\n" },
      fakes: (dir) => ({ bin: { java: whenInvoked(["-jar", join(dir, "tools", "checkstyle.jar"), "-c", "/google_checks.xml", "-f", "xml", join(dir, "src")], CHECKSTYLE_XML(dir)) } }),
      ...tools([
        ["src/Main.java", 3, "R11", "documentation", "HIGH", "MissingJavadocMethodCheck"],
        ["src/Main.java", 7, "R14", "build", "LOW", "LineLengthCheck"],
      ]),
    },
    {
      name: "checkstyle: an unparsable report is no findings",
      tool: "checkstyle",
      stack: "java",
      files: { "tools/checkstyle.jar": "jar", "src/Main.java": "class Main {}\n" },
      fakes: () => ({ bin: { java: printing("<checkstyle><file") } }),
      ...tools([]),
    },
    { name: "an unregistered tool is skipped", tool: "nonexistent", fakes: () => ({}), status: "skipped", error: "No runner registered for tool 'nonexistent'" },
    {
      name: "a tool past its deadline times out",
      tool: "eslint",
      fakes: () => ({ local: { eslint: "sleep 5\n" } }),
      options: { timeoutMs: 300 },
      status: "timeout",
      error: "Tool timed out after 0.3s",
    },
    {
      name: "a transient failure is retried once",
      tool: "eslint",
      fakes: (dir) => ({ local: { eslint: FLAKY_ESLINT(dir) } }),
      ...tools([["src/app.tsx", 3, "R09", "clean-code", "MEDIUM", "no-console"]]),
    },
    { name: "output that never parses fails after the retry", tool: "eslint", fakes: () => ({ local: { eslint: "echo not-json\n" } }), status: "failed", error: "SyntaxError" },
    {
      name: "a message without a line fails the tool",
      tool: "eslint",
      fakes: (dir) => eslintFake(dir, [{ ruleId: "no-console", message: "Unexpected console statement." }]),
      status: "failed",
      error: "TypeError",
    },
    {
      name: "jscpd: duplicates by size, the report lives outside the project and is removed",
      tool: "jscpd",
      files: { "src/a.ts": "x\n" },
      fakes: (dir) => ({ local: { jscpd: jscpdFake(dir, "src/") } }),
      ...tools([
        ["src/a.ts", 3, "R01", "ssot-dry", "MEDIUM", ""],
        ["src/c.ts", 1, "R01", "ssot-dry", "LOW", ""],
      ]),
      snippets: ["25 duplicated lines also in src/b.ts:10", "6 duplicated lines also in src/d.ts:2"],
      afterRun: (dir) => expectRecordedReportRemoved(dir),
    },
    {
      name: "jscpd: a project without src scans its root",
      tool: "jscpd",
      fakes: (dir) => ({ local: { jscpd: jscpdFake(dir, ".") } }),
      ...tools([
        ["src/a.ts", 3, "R01", "ssot-dry", "MEDIUM", ""],
        ["src/c.ts", 1, "R01", "ssot-dry", "LOW", ""],
      ]),
    },
    {
      name: "knip: unused files, object exports and dependencies; other export entries are skipped",
      tool: "knip",
      fakes: () => ({
        local: {
          knip: whenInvoked(
            ["--reporter", "json", "--no-progress"],
            JSON.stringify({ files: ["src/unused.ts"], exports: [{ file: "src/a.ts", name: "helper", line: 4 }, "bad-entry"], dependencies: ["left-pad", { name: "lodash" }] }),
          ),
        },
      }),
      ...tools([
        ["src/unused.ts", 1, "R09", "clean-code", "MEDIUM", ""],
        ["src/a.ts", 4, "R09", "clean-code", "LOW", ""],
        ["package.json", 1, "R14", "build", "LOW", ""],
        ["package.json", 1, "R14", "build", "LOW", ""],
      ]),
      snippets: ["Entire file is unused (not imported anywhere)", "Unused export: helper", "Unused dependency: left-pad", "Unused dependency: lodash"],
    },
    { name: "knip: unparsable output is no findings", tool: "knip", fakes: () => ({ local: { knip: "echo nope\n" } }), ...tools([]) },
    {
      name: "madge: only real cycles are reported, as a chain",
      tool: "madge",
      files: { "src/a.ts": "x\n" },
      fakes: () => ({ local: { madge: whenInvoked(["--circular", "--json", "src/"], JSON.stringify([["a.ts", "b.ts", "a.ts"], ["solo.ts"]])) } }),
      ...tools([["a.ts", 1, "R10", "refactoring", "MEDIUM", ""]]),
      snippets: ["Circular: a.ts -> b.ts -> a.ts"],
    },
    {
      name: "radon: complexity thresholds decide severity and absolute paths are made relative",
      tool: "radon",
      stack: "python",
      fakes: (dir) => ({
        bin: {
          radon: whenInvoked(
            ["cc", ".", "-s", "-j", "--min", "C"],
            JSON.stringify({
              [join(dir, "app.py")]: [
                { name: "big", complexity: 21, lineno: 7, rank: "D" },
                { name: "mid", complexity: 12, lineno: 30, rank: "C" },
                { name: "low", complexity: 9, lineno: 50, rank: "B" },
              ],
            }),
          ),
        },
      }),
      ...tools([
        ["app.py", 7, "R02", "architecture", "HIGH", ""],
        ["app.py", 30, "R02", "architecture", "MEDIUM", ""],
      ]),
      snippets: ["big: complexity 21 (rank D)", "mid: complexity 12 (rank C)"],
    },
    {
      name: "vulture: parsed lines only, confidence below ninety is medium",
      tool: "vulture",
      stack: "python",
      fakes: (dir) => ({
        bin: {
          vulture: whenInvoked(
            [".", "--min-confidence", "80"],
            ["app/dead.py:12: unused function 'old' (95% confidence)", "app/x.py:3: unused import 'os' (80% confidence)", `${join(dir, "y.py")}:1: unused variable 'z' (90% confidence)`, "garbage line"].join("\n"),
          ),
        },
      }),
      ...tools([
        ["app/dead.py", 12, "R09", "clean-code", "LOW", ""],
        ["app/x.py", 3, "R09", "clean-code", "LOW", ""],
        ["y.py", 1, "R09", "clean-code", "LOW", ""],
      ]),
      confidences: ["high", "medium", "high"],
      snippets: ["unused function 'old' (95% confidence)", "unused import 'os' (80% confidence)", "unused variable 'z' (90% confidence)"],
    },
    {
      name: "gitleaks: a secret is reported redacted and its report is removed",
      tool: "gitleaks",
      fakes: (dir) => ({ bin: { gitleaks: gitleaksFake(dir, GITLEAKS_REPORT) } }),
      ...tools([["src/config.ts", 12, "R05", "security", "CRITICAL", "aws-access-token"]]),
      snippets: ["[REDACTED] AWS Access Key"],
      forbidden: SECRET,
      afterRun: (dir) => expectRecordedReportRemoved(dir),
    },
    {
      name: "gitleaks: an unparsable report is no findings",
      tool: "gitleaks",
      fakes: (dir) => ({ bin: { gitleaks: gitleaksFake(dir, "not json") } }),
      ...tools([]),
      afterRun: (dir) => expectRecordedReportRemoved(dir),
    },
    {
      name: "gitleaks: a timeout still removes the report",
      tool: "gitleaks",
      fakes: (dir) => ({ bin: { gitleaks: `echo "$8" > "${join(dir, "report-path.txt")}"\nsleep 5\n` } }),
      options: { timeoutMs: FAKE_START_TIMEOUT_MS },
      status: "timeout",
      error: "Tool timed out",
      afterRun: (dir) => expectRecordedReportRemoved(dir),
    },
    {
      name: "pip-audit: severity comes from the report, else from the description",
      tool: "pip-audit",
      stack: "python",
      fakes: () => ({
        bin: {
          "pip-audit": whenInvoked(
            ["--format", "json"],
            JSON.stringify({
              dependencies: [
                {
                  name: "django",
                  version: "3.0",
                  vulns: [
                    { id: "PYSEC-1", description: "A critical flaw", fix_versions: ["3.1"] },
                    { id: "PYSEC-2", description: "minor", severity: "low" },
                    { id: "PYSEC-3", description: "plain" },
                  ],
                },
                { name: "safe", version: "1", vulns: [] },
              ],
            }),
          ),
        },
      }),
      ...tools([
        ["requirements.txt", 1, "R05", "security", "HIGH", ""],
        ["requirements.txt", 1, "R05", "security", "LOW", ""],
        ["requirements.txt", 1, "R05", "security", "MEDIUM", ""],
      ]),
      snippets: ["django==3.0: PYSEC-1", "django==3.0: PYSEC-2", "django==3.0: PYSEC-3"],
    },
    {
      name: "npm-audit: Bun audit advisories become one finding per package at its worst severity",
      tool: "npm-audit",
      files: BUN_LOCK_FILES,
      fakes: () => ({}),
      registry: {
        lodash: [
          { id: 1, title: "Prototype Pollution in lodash", severity: "high" },
          { id: 2, title: "Command Injection in lodash", severity: "critical" },
        ],
        minimist: [{ id: 3, title: "Prototype Pollution in minimist", severity: "moderate" }],
      },
      ...tools([
        ["package.json", 1, "R05", "security", "CRITICAL", ""],
        ["package.json", 1, "R05", "security", "MEDIUM", ""],
      ]),
      snippets: ["lodash: Prototype Pollution in lodash; Command Injection in lodash", "minimist: Prototype Pollution in minimist"],
    },
    { name: "npm-audit: no advisories is a clean success", tool: "npm-audit", files: BUN_LOCK_FILES, fakes: () => ({}), registry: {}, ...tools([]) },
    {
      name: "npm-audit: a project without a Bun lockfile is skipped, not clean",
      tool: "npm-audit",
      files: { "package-lock.json": "{}\n" },
      fakes: () => ({}),
      status: "skipped",
      error: "bun.lock",
    },
    {
      name: "npm-audit: an unreachable advisory source fails the tool, not a clean result",
      tool: "npm-audit",
      files: BUN_LOCK_FILES,
      fakes: () => ({}),
      registry: { error: "unavailable" },
      registryStatus: 503,
      status: "failed",
      error: "bun audit",
    },
    {
      name: "runTool returns the findings of a successful run",
      tool: "eslint",
      fakes: (dir) => eslintFake(dir, [{ ruleId: "no-console", message: "Unexpected console statement.", line: 3 }]),
      viaRunTool: true,
      ...tools([["src/app.tsx", 3, "R09", "clean-code", "MEDIUM", "no-console"]]),
    },
    { name: "runTool returns nothing for a failing tool", tool: "eslint", fakes: () => ({ local: { eslint: "echo not-json\n" } }), viaRunTool: true, ...tools([]) },
  ])("$name", async ({ tool, stack, files, fakes, options, status, rows, error, viaRunTool, snippets, confidences, forbidden, afterRun, registry, registryStatus }) => {
    const root = projectFiles({ [`${PROJECT_DIR_NAME}/package.json`]: "{}\n", ...Object.fromEntries(Object.entries(files ?? {}).map(([path, content]) => [`${PROJECT_DIR_NAME}/${path}`, content])) });
    const dir = join(root, PROJECT_DIR_NAME);
    const { bin = {}, local = {} } = fakes(dir);
    for (const [name, body] of Object.entries(local)) writeExecutable(join(dir, "node_modules", ".bin", name), body);
    const settings = { retryDelayMs: NO_RETRY_DELAY_MS, ...options };
    const toRows = (findings: { file: string; line: number; rule: string; category: string; severity: string; tool_rule_id: string }[]): Row[] =>
      findings.map((f) => [f.file, f.line, f.rule, f.category, f.severity, f.tool_rule_id]);
    const fakeRegistry = registry === undefined ? undefined : await startRegistry(registry, registryStatus);
    if (fakeRegistry !== undefined) writeFileSync(join(dir, "bunfig.toml"), `[install]\nregistry = "${fakeRegistry.url}"\n`);

    try {
      await withToolEnvironment(bin, async () => {
        if (viaRunTool === true) {
          expect(toRows(await runTool(tool, dir, stack ?? "typescript"))).toEqual(rows ?? []);
          return;
        }
        const result = await runToolSafe(tool, dir, stack ?? "typescript", settings);
        expect(result.status).toBe(status);
        if (error !== undefined) expect(result.error).toContain(error);
        if (rows !== undefined) {
          expect(toRows(result.findings)).toEqual(rows);
          expect(result.findingCount).toBe(rows.length);
        }
        if (snippets !== undefined) expect(result.findings.map((f) => f.snippet)).toEqual(snippets);
        if (confidences !== undefined) expect(result.findings.map((f) => f.confidence)).toEqual(confidences);
        if (forbidden !== undefined) expect(JSON.stringify(result.findings)).not.toContain(forbidden);
        afterRun?.(dir);
      });
    } finally {
      fakeRegistry?.stop();
    }
  });
});

interface DetectCase {
  name: string;
  stack: string;
  files?: Record<string, string>;
  fakes: (dir: string) => Fakes;
  projectDir?: string;
  expected: string[];
}

const VERSION_OK = "exit 0\n";
const AGNOSTIC = ["env-check", "coverage", "assertion-check"];

describe("detectTools", () => {
  it.each<DetectCase>([
    {
      name: "typescript: project-local and PATH tools that answer their version probe",
      stack: "typescript",
      fakes: () => ({ local: { eslint: VERSION_OK, knip: VERSION_OK }, bin: { semgrep: VERSION_OK, gitleaks: VERSION_OK } }),
      expected: ["eslint", "semgrep", "knip", "npm-audit", "gitleaks", ...AGNOSTIC],
    },
    {
      name: "python: a tool whose probe fails is not available",
      stack: "python",
      fakes: () => ({ bin: { ruff: VERSION_OK, mypy: "exit 1\n", vulture: VERSION_OK, "pip-audit": VERSION_OK } }),
      expected: ["ruff", "vulture", "pip-audit", ...AGNOSTIC],
    },
    {
      name: "java: checkstyle needs a jar and a java that runs it",
      stack: "java",
      files: { "tools/checkstyle.jar": "jar" },
      fakes: () => ({ bin: { java: VERSION_OK } }),
      expected: ["checkstyle", ...AGNOSTIC],
    },
    { name: "java: no jar means no checkstyle", stack: "java", fakes: () => ({ bin: { java: VERSION_OK } }), expected: AGNOSTIC },
    { name: "an unknown stack keeps only the tools that need no binary", stack: "cobol", fakes: () => ({}), expected: AGNOSTIC },
    { name: "a project directory that does not exist keeps only the tools that need no binary", stack: "typescript", fakes: () => ({}), projectDir: "/nonexistent/project", expected: AGNOSTIC },
  ])("$name", async ({ stack, files, fakes, projectDir, expected }) => {
    const root = projectFiles({ [`${PROJECT_DIR_NAME}/package.json`]: "{}\n", ...Object.fromEntries(Object.entries(files ?? {}).map(([path, content]) => [`${PROJECT_DIR_NAME}/${path}`, content])) });
    const dir = join(root, PROJECT_DIR_NAME);
    const { bin = {}, local = {} } = fakes(dir);
    for (const [name, body] of Object.entries(local)) writeExecutable(join(dir, "node_modules", ".bin", name), body);
    await withToolEnvironment(bin, () => {
      expect(detectTools(stack, projectDir ?? dir)).toEqual(expected);
    });
  });
});
