import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import type { Finding } from "@quality/types.ts";
import { detectAssertionFreeTests } from "@rinnegan/assertion_detector.ts";
import { analyzeCoverage } from "@rinnegan/coverage_analyzer.ts";
import { checkEnv } from "@rinnegan/env_checker.ts";

// Run git against a fixture project with the hook-injected repository variables removed.
function git(root: string, args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function gitProject(files: Record<string, string>, tracked: string[]): string {
  const root = projectFiles(files);
  git(root, ["init", "-q"]);
  if (tracked.length > 0) git(root, ["add", "--force", ...tracked]);
  return root;
}

const TRACKED_ENV_DESCRIPTION =
  "Environment file '.env' is committed to git. This may expose secrets. Add it to .gitignore and remove from tracking.";

describe("checkEnv", () => {
  it("reports a tracked env file as one complete critical finding without its contents", () => {
    const root = gitProject({ ".env": "SECRET_TOKEN=hunter2-value\n" }, [".env"]);
    const findings = checkEnv(root);
    expect(findings).toEqual([
      {
        rule: "R05",
        severity: "CRITICAL",
        category: "security",
        file: ".env",
        line: 1,
        end_line: 1,
        snippet: TRACKED_ENV_DESCRIPTION,
        current_code: TRACKED_ENV_DESCRIPTION,
        description: TRACKED_ENV_DESCRIPTION,
        explanation: TRACKED_ENV_DESCRIPTION,
        search_pattern: "",
        phase: 1,
        effort: "low",
        scanner: "env-check",
        confidence: "high",
        confidence_reason: "Deterministic: git ls-files shows '.env' is tracked",
        tool_rule_id: "",
        cwe: [],
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("hunter2-value");
  });

  it.each<{ name: string; files: Record<string, string>; tracked: string[]; expected: [string, string, string, number][]; vars?: string[] }>([
    {
      name: "every tracked env variant is reported, in git's order",
      files: { ".env": "A=1\n", ".env.production": "B=2\n", ".env.local": "C=3\n" },
      tracked: [".env", ".env.production"],
      expected: [
        ["R05", "CRITICAL", ".env", 1],
        ["R05", "CRITICAL", ".env.production", 1],
      ],
    },
    { name: "an untracked env file is clean", files: { ".env": "A=1\n" }, tracked: [], expected: [] },
    {
      name: "a gitignored env without an example asks for one",
      files: { ".gitignore": "node_modules/\n.env\n" },
      tracked: [],
      expected: [["R12", "MEDIUM", ".gitignore", 1]],
    },
    { name: "a commented ignore line does not count", files: { ".gitignore": "# .env\ndist/\n" }, tracked: [], expected: [] },
    { name: "an example file satisfies the ignored env", files: { ".gitignore": ".env\n", ".env.example": "API_KEY=\n" }, tracked: [], expected: [] },
    {
      name: "a duplicate example key is reported at its second line",
      files: { ".env.example": "API_KEY=abc\nDB_HOST=localhost\nAPI_KEY=xyz\n" },
      tracked: [],
      expected: [["R09", "LOW", ".env.example", 3]],
    },
    { name: "comments and blank lines are not keys", files: { ".env.example": "# comment\n\nAPI_KEY=x\n# another\nDB=y\n" }, tracked: [], expected: [] },
    {
      name: "a variable read in TypeScript but absent from the example",
      files: { ".env.example": "API_KEY=\nDB_HOST=\n", "app.ts": "const key = process.env.API_KEY;\nconst s = process.env.SECRET_TOKEN;\n" },
      tracked: [],
      expected: [["R12", "LOW", ".env.example", 1]],
      vars: ["SECRET_TOKEN"],
    },
    {
      name: "every Python environment read form",
      files: {
        ".env.example": "KNOWN_VAR=\n",
        "main.py": 'import os\na = os.environ["ALPHA"]\nb = os.environ.get("BETA")\nc = os.getenv("GAMMA")\nd = os.getenv(\'DELTA\')\n',
      },
      tracked: [],
      expected: [
        ["R12", "LOW", ".env.example", 1],
        ["R12", "LOW", ".env.example", 1],
        ["R12", "LOW", ".env.example", 1],
        ["R12", "LOW", ".env.example", 1],
      ],
      vars: ["ALPHA", "BETA", "DELTA", "GAMMA"],
    },
    { name: "a present variable is clean", files: { ".env.example": "DB_HOST=\n", "config.py": 'url = os.getenv("DB_HOST")\n' }, tracked: [], expected: [] },
    { name: "no example means no drift check", files: { "app.js": "const x = process.env.MISSING;\n" }, tracked: [], expected: [] },
    {
      name: "dependency directories are not read",
      files: { ".env.example": "APP_KEY=\n", "node_modules/lib/index.js": "process.env.HIDDEN_VAR;\n" },
      tracked: [],
      expected: [],
    },
  ])("$name", ({ files, tracked, expected, vars }) => {
    const findings = checkEnv(gitProject(files, tracked));
    expect(findings.map((f) => [f.rule, f.severity, f.file, f.line])).toEqual(expected);
    if (vars !== undefined) expect(findings.map((f) => f.description.split("'")[1])).toEqual(vars);
  });
});

const ASSERTION_FINDING_DESCRIPTION = "Test 'test_empty' has no assertions";

describe("detectAssertionFreeTests", () => {
  it("emits the complete finding for an assertion-free Python test", () => {
    const root = projectFiles({ "tests/test_fields.py": "def test_empty():\n    pass\n" });
    expect(detectAssertionFreeTests(root, "python")).toEqual([
      {
        rule: "R08",
        severity: "MEDIUM",
        category: "build",
        file: "tests/test_fields.py",
        line: 1,
        end_line: 1,
        snippet: ASSERTION_FINDING_DESCRIPTION,
        current_code: ASSERTION_FINDING_DESCRIPTION,
        description: ASSERTION_FINDING_DESCRIPTION,
        explanation: ASSERTION_FINDING_DESCRIPTION,
        search_pattern: "",
        phase: 9,
        effort: "low",
        scanner: "assertion-detector",
        confidence: "high",
        confidence_reason: "Deterministic: AST/grep assertion analysis",
        tool_rule_id: "no-assertions",
        cwe: [],
      },
    ]);
  });

  const described = (findings: Finding[]): [string, number][] => findings.map((f) => [f.description, f.line]);

  it.each<{ name: string; stack: string; files: Record<string, string>; expected: [string, number][] }>([
    {
      name: "a function that only prints",
      stack: "python",
      files: { "test_smoke.py": "def test_smoke():\n    result = 1 + 1\n    print(result)\n" },
      expected: [["Test 'test_smoke' has no assertions", 1]],
    },
    { name: "an assert statement", stack: "python", files: { "test_math.py": "def test_add():\n    assert 1 + 1 == 2\n" }, expected: [] },
    {
      name: "pytest.raises",
      stack: "python",
      files: { "test_err.py": "import pytest\n\ndef test_error():\n    with pytest.raises(ValueError):\n        int('x')\n" },
      expected: [],
    },
    {
      name: "a unittest self.assert call in a class",
      stack: "python",
      files: { "test_foo.py": "import unittest\n\nclass TestFoo(unittest.TestCase):\n    def test_bar(self):\n        self.assertEqual(1, 1)\n" },
      expected: [],
    },
    {
      name: "a mock assert_called_once call",
      stack: "python",
      files: { "test_mock.py": "def test_mock():\n    mock = make()\n    mock.do_thing()\n    mock.do_thing.assert_called_once()\n" },
      expected: [],
    },
    {
      name: "a helper that is not a test",
      stack: "python",
      files: { "test_helper.py": "def helper():\n    pass\n\ndef test_real():\n    assert True\n" },
      expected: [],
    },
    {
      name: "only the assertion-free functions of a mixed file",
      stack: "python",
      files: { "test_mixed.py": "def test_good():\n    assert True\n\ndef test_bad():\n    x = 1\n\ndef test_also_bad():\n    pass\n" },
      expected: [
        ["Test 'test_bad' has no assertions", 4],
        ["Test 'test_also_bad' has no assertions", 7],
      ],
    },
    {
      name: "an async test and a decorated one",
      stack: "python",
      files: { "test_async.py": "async def test_async_no_assert():\n    result = await something()\n\n@decorate\nasync def test_decorated():\n    pass\n" },
      expected: [
        ["Test 'test_async_no_assert' has no assertions", 1],
        ["Test 'test_decorated' has no assertions", 5],
      ],
    },
    {
      name: "a nested test function is judged on its own",
      stack: "python",
      files: { "test_nested.py": "class TestGroup:\n    def test_outer(self):\n        def test_inner():\n            pass\n        assert True\n" },
      expected: [["Test 'test_inner' has no assertions", 3]],
    },
    { name: "a syntax error is skipped", stack: "python", files: { "test_broken.py": "def test_x(:\n    pass\n" }, expected: [] },
    { name: "a suffix-named test file is scanned", stack: "python", files: { "util_test.py": "def test_x():\n    pass\n" }, expected: [["Test 'test_x' has no assertions", 1]] },
    { name: "a non-test file is not scanned", stack: "python", files: { "utils.py": "def test_x():\n    pass\n" }, expected: [] },
    { name: "dependency directories are not scanned", stack: "python", files: { "node_modules/pkg/test_pkg.py": "def test_x():\n    pass\n" }, expected: [] },
    {
      name: "TypeScript test with expect",
      stack: "typescript",
      files: { "math.test.ts": "test('adds numbers', () => {\n  expect(1 + 1).toBe(2);\n});\n" },
      expected: [],
    },
    {
      name: "TypeScript test without expect",
      stack: "typescript",
      files: { "smoke.test.ts": "test('smoke test', () => {\n  console.log(1);\n});\n" },
      expected: [["Test 'smoke test' has no assertions", 1]],
    },
    {
      name: "TypeScript it block without expect inside describe",
      stack: "typescript",
      files: { "utils.spec.ts": "describe('Utils', () => {\n  it('should work', () => {\n    const x = 1;\n  });\n});\n" },
      expected: [["Test 'should work' has no assertions", 2]],
    },
    {
      name: "TypeScript mixed blocks flag only the bad one",
      stack: "typescript",
      files: {
        "mixed.test.ts":
          "test('good test', () => {\n  expect(1).toBe(1);\n});\n\ntest('bad test', () => {\n  console.log('x');\n});\n\ntest('another good', () => {\n  expect(value).toBeTruthy();\n});\n",
      },
      expected: [["Test 'bad test' has no assertions", 5]],
    },
    { name: "an empty TypeScript test file", stack: "typescript", files: { "empty.test.ts": "" }, expected: [] },
    { name: "Java is not analysed", stack: "java", files: { "FooTest.java": "class FooTest {}\n" }, expected: [] },
  ])("$name", ({ stack, files, expected }) => {
    expect(described(detectAssertionFreeTests(projectFiles(files), stack))).toEqual(expected);
  });
});

const NO_REPORT = ["project", 1, "No test coverage report found. Run tests with coverage enabled."];
const JACOCO_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<report name="test">\n  <package name="com/example">\n';
const JACOCO_TAIL = "  </package>\n</report>\n";
const JACOCO_PATH = "target/site/jacoco/jacoco.xml";
const jacoco = (classes: string): Record<string, string> => ({ [JACOCO_PATH]: JACOCO_HEAD + classes + JACOCO_TAIL });
const method = (name: string, line: number, counter: string): string =>
  `<method name="${name}" line="${line}"><counter type="${counter}" missed="1" covered="0"/></method>`;
const PYTHON_COVERAGE_JSON =
  '{"files": {"app/x.py": {"functions": {"f": {"summary": {"percent_covered": 0.0}, "line": 4}}}}}';
const ISTANBUL_PATH = "coverage/coverage-final.json";

interface CoverageCase {
  name: string;
  stack: string;
  files: (root: string) => Record<string, string>;
  bin?: string | null;
  expected?: [string, number, string][];
  absent?: string;
  throws?: boolean;
}

// A scratch directory standing in for the whole PATH, holding at most a fake coverage tool.
function withToolPath<T>(script: string | null, run: () => T): T {
  const binDir = mkdtempSync(join(tmpdir(), "quality-skills-bin-"));
  if (script !== null) {
    const tool = join(binDir, "coverage");
    writeFileSync(tool, script);
    chmodSync(tool, 0o755);
  }
  const saved = process.env["PATH"];
  process.env["PATH"] = binDir;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe("analyzeCoverage", () => {
  it.each<CoverageCase>([
    { name: "an unknown stack has no report", stack: "cobol", files: () => ({}), expected: [NO_REPORT as [string, number, string]] },
    { name: "a missing Istanbul report", stack: "typescript", files: () => ({}), expected: [NO_REPORT as [string, number, string]] },
    { name: "an unparsable Istanbul report", stack: "typescript", files: () => ({ [ISTANBUL_PATH]: "{invalid json" }), expected: [NO_REPORT as [string, number, string]] },
    {
      name: "a fully covered Istanbul report is clean",
      stack: "typescript",
      files: () => ({ [ISTANBUL_PATH]: JSON.stringify({ "src/app.ts": { fnMap: { "0": { name: "main", line: 1 } }, f: { "0": 5 } } }) }),
      expected: [],
    },
    {
      name: "an uncovered Istanbul function is reported at its line",
      stack: "typescript",
      files: () => ({
        [ISTANBUL_PATH]: JSON.stringify({
          "src/utils.ts": {
            fnMap: { "0": { name: "usedFn", line: 1 }, "1": { name: "unusedFn", line: 10, loc: { start: { line: 10 } } } },
            f: { "0": 2, "1": 0 },
          },
        }),
      }),
      expected: [["src/utils.ts", 10, "Function 'unusedFn' has zero test coverage"]],
    },
    {
      name: "an absolute path is made relative; a nameless function falls back to its loc and id",
      stack: "typescript",
      files: (root) => ({
        [ISTANBUL_PATH]: JSON.stringify({ [join(root, "src", "abs.ts")]: { fnMap: { "0": { loc: { start: { line: 7 } } } }, f: { "0": 0, "1": 0 } } }),
      }),
      expected: [
        ["src/abs.ts", 7, "Function 'anonymous_0' has zero test coverage"],
        ["src/abs.ts", 1, "Function 'anonymous_1' has zero test coverage"],
      ],
    },
    {
      name: "uncovered functions in several Istanbul files",
      stack: "typescript",
      files: () => ({
        [ISTANBUL_PATH]: JSON.stringify({
          "src/a.ts": { fnMap: { "0": { name: "fn_a", line: 1 } }, f: { "0": 0 } },
          "src/b.ts": { fnMap: { "0": { name: "fn_b", line: 5 } }, f: { "0": 0 } },
        }),
      }),
      expected: [
        ["src/a.ts", 1, "Function 'fn_a' has zero test coverage"],
        ["src/b.ts", 5, "Function 'fn_b' has zero test coverage"],
      ],
    },
    {
      name: "coverage.py reports only zero-percent functions, with a floating-point tolerance",
      stack: "python",
      files: () => ({
        "coverage.json": JSON.stringify({
          files: {
            "app/utils.py": {
              functions: {
                used_fn: { summary: { percent_covered: 85.0 }, line: 1 },
                unused_fn: { summary: { percent_covered: 0.0 }, line: 20 },
                tiny_fn: { summary: { percent_covered: 0.005 }, line: 30 },
                small_fn: { summary: { percent_covered: 0.02 }, line: 40 },
              },
            },
          },
        }),
      }),
      expected: [
        ["app/utils.py", 20, "Function 'unused_fn' has zero test coverage"],
        ["app/utils.py", 30, "Function 'tiny_fn' has zero test coverage"],
      ],
    },
    { name: "an unparsable coverage.json", stack: "python", files: () => ({ "coverage.json": "not json {{{" }), expected: [NO_REPORT as [string, number, string]] },
    {
      name: "coverage.json is generated from .coverage by the coverage tool",
      stack: "python",
      files: () => ({ ".coverage": "data" }),
      bin: `#!/bin/sh\nprintf '%s' '${PYTHON_COVERAGE_JSON}' > "$3"\n`,
      expected: [["app/x.py", 4, "Function 'f' has zero test coverage"]],
    },
    { name: "a failing coverage tool means no report", stack: "python", files: () => ({ ".coverage": "data" }), bin: "#!/bin/sh\nexit 1\n", expected: [NO_REPORT as [string, number, string]] },
    { name: "no coverage tool installed means no report", stack: "python", files: () => ({ ".coverage": "data" }), bin: null, expected: [NO_REPORT as [string, number, string]] },
    {
      name: "an uncovered JaCoCo method is reported under its source path",
      stack: "java",
      files: () => jacoco(`<class name="com/example/App" sourcefilename="App.java">${method("main", 12, "METHOD")}</class>\n`),
      expected: [["src/main/java/com/example/App.java", 12, "Method 'com.example.App.main' has zero test coverage"]],
    },
    {
      name: "covered JaCoCo methods and non-method counters are clean",
      stack: "java",
      files: () =>
        jacoco(
          `<class name="com/example/App" sourcefilename="App.java"><method name="ok" line="5"><counter type="METHOD" missed="0" covered="1"/></method>${method("lines", 9, "LINE")}</class>\n`,
        ),
      expected: [],
    },
    { name: "an unparsable JaCoCo report", stack: "java", files: () => ({ [JACOCO_PATH]: "<not valid xml" }), expected: [NO_REPORT as [string, number, string]] },
    {
      name: "XML entities in method names are decoded",
      stack: "java",
      files: () => jacoco(`<class name="com/example/Svc" sourcefilename="Svc.java">${method("&lt;init&gt;", 3, "METHOD")}</class>\n`),
      expected: [["src/main/java/com/example/Svc.java", 3, "Method 'com.example.Svc.<init>' has zero test coverage"]],
    },
    {
      name: "a class without a source file is named by its dotted class name",
      stack: "java",
      files: () => jacoco(`<class name="com/example/Gen">${method("m", 2, "METHOD")}</class>\n`),
      expected: [["com.example.Gen", 2, "Method 'com.example.Gen.m' has zero test coverage"]],
    },
    {
      name: "a declared entity bomb is not expanded",
      stack: "java",
      files: () => ({
        [JACOCO_PATH]:
          '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
          `<report><package name="p"><class name="p/C" sourcefilename="C.java"><method name="&lol3;&lol3;" line="1"><counter type="METHOD" missed="1" covered="0"/></method></class></package></report>`,
      }),
      absent: "lollol",
    },
    { name: "a non-numeric line attribute fails the analysis", stack: "java", files: () => jacoco(`<class name="com/example/A" sourcefilename="A.java">${method("m", NaN, "METHOD")}</class>\n`), throws: true },
  ])("$name", ({ stack, files, bin, expected, absent, throws }) => {
    const root = projectFiles({});
    for (const [rel, content] of Object.entries(files(root))) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const run = (): Finding[] => analyzeCoverage(root, stack);
    const analyse = bin === undefined ? run : (): Finding[] => withToolPath(bin, run);
    if (throws === true) {
      expect(analyse).toThrow();
      return;
    }
    const findings = analyse();
    for (const f of findings) {
      const advisory = f.file === "project";
      expect(f).toMatchObject({
        rule: "R08",
        severity: "MEDIUM",
        category: "build",
        end_line: f.line,
        snippet: f.description,
        explanation: f.description,
        search_pattern: "",
        phase: 9,
        effort: "medium",
        scanner: "coverage-analyzer",
        confidence: "high",
        current_code: advisory ? "" : f.description,
        confidence_reason: advisory ? "Deterministic: no coverage report detected" : "Deterministic: coverage report analysis",
        tool_rule_id: advisory ? "no-coverage-report" : "zero-coverage",
        cwe: [],
      });
    }
    if (expected !== undefined) expect(findings.map((f) => [f.file, f.line, f.description])).toEqual(expected);
    if (absent !== undefined) expect(JSON.stringify(findings)).not.toContain(absent);
  });
});
