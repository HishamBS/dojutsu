import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@quality/io.ts";
import { projectFiles } from "@quality-test/project-files.ts";
import { buildInventory } from "@rinnegan/create-inventory.ts";
import { scanProject, writeResults } from "@rinnegan/grep_scanner_lib.ts";

const SCANNER_CLI = join(import.meta.dir, "..", "scripts", "grep-scanner.ts");

function runScanner(args: string[]): { status: number | null; stdout: string } {
  const result = Bun.spawnSync([process.execPath, SCANNER_CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

// Split so this file's own source never spells the vendor package name contiguously.
const SDK_PACKAGE_LITERAL = "@" + "hum" + "ain" + "/sdk";

interface Expectation {
  rule: string;
  file: string;
  count?: number;
  min?: number;
  severity?: string;
  category?: string;
  layer?: string;
  description?: RegExp;
  absent?: RegExp;
}

interface ScanCase {
  name: string;
  files: Record<string, string>;
  layers?: Record<string, string>;
  unique?: boolean;
  stack?: string;
  expected: Expectation[];
}

const SERVICES = "services";

function scan(files: Record<string, string>, layers: Record<string, string> | undefined, stack = "typescript") {
  const dir = projectFiles(files);
  const sourceFiles = Object.keys(files);
  const fileToLayer = layers ?? Object.fromEntries(sourceFiles.map((path) => [path, SERVICES]));
  return scanProject(dir, sourceFiles, stack, fileToLayer).findings;
}

describe("scanProject on a TypeScript project", () => {
  it.each<ScanCase>([
    {
      name: "a colon-any field in a types file",
      files: { "types/models.ts": "export interface User {\n  data: any;\n}\n" },
      layers: { "types/models.ts": "types" },
      expected: [{ rule: "R07", file: "types/models.ts", count: 1, severity: "HIGH", category: "typing", layer: "types" }],
    },
    {
      name: "a type alias assigned to any",
      files: { "types/aliases.ts": "export type ApiResponse = any;\n" },
      expected: [{ rule: "R07", file: "types/aliases.ts", count: 1, description: /alias|any/i }],
    },
    {
      name: "any as a Record generic parameter",
      files: { "types/maps.ts": "export type DataMap = Record<string, any>;\n" },
      expected: [{ rule: "R07", file: "types/maps.ts", description: /generic|parameter/i }],
    },
    {
      name: "any as an Array generic parameter",
      files: { "types/arrays.ts": "export type Items = Array<any>;\n" },
      expected: [{ rule: "R07", file: "types/arrays.ts" }],
    },
    {
      name: "an as-any assertion in src/types",
      files: { "src/types/casting.ts": "const result = data as any;\n" },
      expected: [{ rule: "R07", file: "src/types/casting.ts", count: 1, description: /assertion|as any/i }],
    },
    {
      name: "console.log in a types file",
      files: { "types/debug.ts": 'console.log("should not be here");\n' },
      layers: { "types/debug.ts": "types" },
      expected: [{ rule: "R09", file: "types/debug.ts", count: 1, layer: "types" }],
    },
    {
      name: "a declaration file in types",
      files: { "types/global.d.ts": "declare const config: any;\n" },
      expected: [{ rule: "R07", file: "types/global.d.ts" }],
    },
    {
      name: "console.log in a component",
      files: { "src/components/App.tsx": 'console.log("hello");\n' },
      expected: [{ rule: "R09", file: "src/components/App.tsx" }],
    },
    {
      name: "eval",
      files: { "src/utils.ts": 'eval("code");\n' },
      expected: [{ rule: "R05", file: "src/utils.ts" }],
    },
    {
      name: "a hardcoded localhost url",
      files: { "src/config.ts": 'const url = "http://localhost:3000";\n' },
      expected: [{ rule: "R12", file: "src/config.ts" }],
    },
    {
      name: "a TODO marker",
      files: { "src/service.ts": "// TODO fix this later\nconst x = 1;\n" },
      expected: [{ rule: "R14", file: "src/service.ts" }],
    },
    {
      name: "a 40-zero placeholder hash",
      files: { "src/x.ts": "const fakeHash = '0'.repeat(40);\n" },
      expected: [{ rule: "R12", file: "src/x.ts" }],
    },
    {
      name: "a 64-zero placeholder hash",
      files: { "src/x.ts": 'const fakeSha = "0".repeat(64);\n' },
      expected: [{ rule: "R12", file: "src/x.ts" }],
    },
    {
      name: "a localhost url in a non-test file",
      files: { "src/client.ts": "const apiBase = 'http://localhost:8080/api';\n" },
      expected: [{ rule: "R12", file: "src/client.ts" }],
    },
    {
      name: "an SDK package-name literal",
      files: { "scripts/release.ts": `const tsPackage = '${SDK_PACKAGE_LITERAL}';\n` },
      expected: [{ rule: "R13", file: "scripts/release.ts" }],
    },
    {
      name: "an h1 manifest filename literal",
      files: { "scripts/loader.ts": "const path = '.h1-routes.json';\n" },
      expected: [{ rule: "R13", file: "scripts/loader.ts" }],
    },
    {
      name: "several violations in one types file",
      files: {
        "types/mixed.ts":
          "export type ApiResponse = any;\n" +
          "export type DataMap = Record<string, any>;\n" +
          "export interface Config {\n  handler: (e: any) => void;\n}\n" +
          'console.log("debug");\n',
      },
      layers: { "types/mixed.ts": "types" },
      expected: [
        { rule: "R07", file: "types/mixed.ts", min: 3 },
        { rule: "R09", file: "types/mixed.ts", count: 1 },
      ],
    },
    {
      name: "no finding for identifiers that merely start with any",
      files: { "src/utils.ts": "const x = anything;\nconst y = anyFunction();\nconst z = any_variable;\n" },
      expected: [{ rule: "R07", file: "src/utils.ts", count: 0 }],
    },
    {
      name: "no finding for commented-out any",
      files: { "types/commented.ts": "// type Foo = any;\n// const x: any = 5;\n/* Record<string, any> */\n" },
      expected: [{ rule: "R07", file: "types/commented.ts", count: 0 }],
    },
    {
      name: "each file, line and rule at most once",
      files: {
        "types/complex.ts":
          "export interface Config {\n  data: any;\n  callback: (args: any[]) => void;\n}\n" + "export type Response = Record<string, any>;\n",
      },
      unique: true,
      expected: [{ rule: "R07", file: "types/complex.ts", min: 3 }],
    },
    {
      name: "no finding inside a test directory",
      files: { "__tests__/App.test.ts": 'console.log("test debug");\n', "src/service.ts": "const x = 1;\n" },
      expected: [{ rule: "R09", file: "__tests__/App.test.ts", count: 0 }],
    },
    {
      name: "no localhost finding in a test file",
      files: { "src/client.test.ts": "const apiBase = 'http://localhost:8080/api';\n" },
      expected: [{ rule: "R12", file: "src/client.test.ts", count: 0 }],
    },
    {
      name: "a rule-definition file is exempt from R09, R13 and R14",
      files: {
        "scripts/ci/enforce-engineering-rules.ts": `const RULE_PATTERNS = [];\n// @ts-nocheck\nconsole.log("x");\nconst pkg = '${SDK_PACKAGE_LITERAL}';\n`,
      },
      layers: { "scripts/ci/enforce-engineering-rules.ts": "config" },
      expected: [
        { rule: "R09", file: "scripts/ci/enforce-engineering-rules.ts", count: 0 },
        { rule: "R13", file: "scripts/ci/enforce-engineering-rules.ts", count: 0 },
        { rule: "R14", file: "scripts/ci/enforce-engineering-rules.ts", count: 0 },
      ],
    },
    {
      name: "a matching filename without the directory and marker is not exempt",
      files: {
        "packages/auth/src/verify-token.ts": "// @ts-nocheck\nexport const x: any = 1;\n",
        "scripts/ci/release-publish.ts": "// @ts-nocheck\nimport { execSync } from 'node:child_process';\n",
      },
      expected: [
        { rule: "R14", file: "packages/auth/src/verify-token.ts", min: 1 },
        { rule: "R14", file: "scripts/ci/release-publish.ts", min: 1 },
      ],
    },
    {
      name: "a ts-nocheck mention inside a regex literal is not a directive",
      files: { "src/rule-detector.ts": "const SUPPRESSION_PATTERN = /@ts-nocheck|eslint-disable/;\nexport function isOk(): boolean { return true; }\n" },
      expected: [{ rule: "R14", file: "src/rule-detector.ts", count: 0 }],
    },
    {
      name: "a ts-nocheck mention inside a string literal is not a directive",
      files: { "src/doc.ts": 'export const docMessage = "use @ts-nocheck for tricky generated files";\n' },
      expected: [{ rule: "R14", file: "src/doc.ts", count: 0 }],
    },
    {
      name: "a real ts-nocheck directive",
      files: { "src/broken.ts": "// @ts-nocheck\nexport const x: any = 1;\n" },
      expected: [{ rule: "R14", file: "src/broken.ts", count: 1 }],
    },
    {
      name: "innerHTML assignment only when it is not a clear",
      files: {
        "src/unsafe.ts": "el.innerHTML = userInput;\n",
        "src/safe-double.ts": 'el.innerHTML = "";\n',
        "src/safe-single.ts": "el.innerHTML = '';\n",
        "src/safe-template.ts": "el.innerHTML = ``;\n",
      },
      expected: [
        { rule: "R05", file: "src/unsafe.ts", min: 1 },
        { rule: "R05", file: "src/safe-double.ts", count: 0 },
        { rule: "R05", file: "src/safe-single.ts", count: 0 },
        { rule: "R05", file: "src/safe-template.ts", count: 0 },
      ],
    },
    {
      name: "console.error outside the server layers only",
      files: { "src/api.ts": "console.error(err);\n", "src/Widget.tsx": "console.error(err);\n" },
      layers: { "src/api.ts": "services", "src/Widget.tsx": "components" },
      expected: [
        { rule: "R09", file: "src/api.ts", count: 0 },
        { rule: "R09", file: "src/Widget.tsx", count: 1 },
      ],
    },
    {
      name: "eval in a Python app",
      stack: "python",
      files: { "app/main.py": "result = eval(user_input)\n" },
      expected: [{ rule: "R05", file: "app/main.py", min: 1, severity: "CRITICAL", category: "security" }],
    },
    {
      name: "a bare except and a type-ignore in Python",
      stack: "python",
      files: { "app/guard.py": "try:\n    run()\nexcept:\n    pass\nvalue = load()  # type: ignore\n" },
      expected: [
        { rule: "R05", file: "app/guard.py", count: 1, severity: "HIGH" },
        { rule: "R14", file: "app/guard.py", count: 1, severity: "MEDIUM" },
      ],
    },
    {
      name: "print in Python code but not in a comment",
      stack: "python",
      files: { "app/out.py": "print('x')\n", "app/quiet.py": "# print('x')\n" },
      expected: [
        { rule: "R09", file: "app/out.py", count: 1 },
        { rule: "R09", file: "app/quiet.py", count: 0 },
      ],
    },
    {
      name: "a localhost literal skipped by the Python test-file glob only for the literal pattern",
      stack: "python",
      files: { "app/client.py": 'url = "http://localhost:8080"\n', "app/client_test.py": 'url = "http://localhost:8080"\n' },
      expected: [
        { rule: "R12", file: "app/client.py", count: 2 },
        { rule: "R12", file: "app/client_test.py", count: 1 },
      ],
    },
    {
      name: "Java println, an empty catch and a public field",
      stack: "java",
      files: { "src/App.java": 'System.out.println("x");\ncatch (Exception e) {}\npublic int count;\n' },
      expected: [
        { rule: "R14", file: "src/App.java", count: 2 },
        { rule: "R02", file: "src/App.java", count: 1, category: "architecture" },
      ],
    },
    {
      name: "a Java raw List type but not its import",
      stack: "java",
      files: { "src/Imp.java": "import java.util.List;\n", "src/Raw.java": "List items = foo();\n" },
      expected: [
        { rule: "R07", file: "src/Imp.java", count: 0 },
        { rule: "R07", file: "src/Raw.java", count: 1 },
      ],
    },
    {
      name: "Kotlin files use the Java patterns",
      stack: "kotlin",
      files: { "src/App.kt": 'System.out.println("x");\n' },
      expected: [{ rule: "R14", file: "src/App.kt", count: 1 }],
    },
    {
      name: "Go println, a discarded error and a panic",
      stack: "go",
      files: { "cmd/main.go": 'fmt.Println("x")\n_ = err\npanic("boom")\n' },
      expected: [{ rule: "R14", file: "cmd/main.go", count: 3 }],
    },
    {
      name: "Go ListenAndServe",
      stack: "go",
      files: { "cmd/serve.go": 'http.ListenAndServe(":80", nil)\n' },
      expected: [{ rule: "R05", file: "cmd/serve.go", count: 1 }],
    },
    {
      name: "Rust unwrap, println and todo",
      stack: "rust",
      files: { "src/lib.rs": 'let v = x.unwrap();\nprintln!("x");\ntodo!();\n' },
      expected: [{ rule: "R14", file: "src/lib.rs", count: 3 }],
    },
    {
      name: "Rust unsafe once, whether or not a SAFETY comment is near",
      stack: "rust",
      files: { "src/bare.rs": "unsafe { read() }\n", "src/noted.rs": "unsafe { read() } // SAFETY: bounds checked\n" },
      expected: [
        { rule: "R05", file: "src/bare.rs", count: 1 },
        { rule: "R05", file: "src/noted.rs", count: 1 },
      ],
    },
    {
      name: "no unsafe-without-SAFETY finding under a preceding-line SAFETY comment",
      stack: "rust",
      files: { "src/ok.rs": "// SAFETY: ptr is valid for reads\nlet v = unsafe { *ptr };\n" },
      expected: [{ rule: "R05", file: "src/ok.rs", absent: /without SAFETY comment/ }],
    },
    {
      name: "no external-URL finding for docstring URLs, environ defaults or a loopback address",
      stack: "python",
      files: {
        "app/urls.py":
          'def f():\n    """See https://docs.example.com/guide for details."""\n' +
          '    return os.environ.get("API_URL", "https://api.example.com")\n' +
          "BASE = http://127.0.0.1:8000\n",
      },
      expected: [{ rule: "R13", file: "app/urls.py", min: 0, absent: /Hardcoded URL should be in configuration/ }],
    },
    {
      name: "no unvalidated-RequestParam finding when validation annotations follow it",
      stack: "java",
      files: { "src/Ctl.java": 'String q(@RequestParam @Size(max = 64) @Pattern(regexp = "[a-z]+") String name) {\n' },
      expected: [{ rule: "R05", file: "src/Ctl.java", min: 0, absent: /@RequestParam without validation/ }],
    },
  ])("reports $name", ({ files, layers, unique, stack, expected }) => {
    const findings = scan(files, layers, stack);
    if (unique === true) {
      const keys = findings.map((finding) => `${finding.file}:${finding.line}:${finding.rule}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    for (const want of expected) {
      const hits = findings.filter((finding) => finding.rule === want.rule && finding.file === want.file);
      if (want.count !== undefined) expect(hits).toHaveLength(want.count);
      else expect(hits.length).toBeGreaterThanOrEqual(want.min ?? 1);
      if (want.absent !== undefined) expect(hits.filter((hit) => want.absent?.test(hit.description) === true)).toHaveLength(0);
      for (const hit of hits) {
        if (want.severity !== undefined) expect(hit.severity).toBe(want.severity);
        if (want.category !== undefined) expect(hit.category).toBe(want.category);
        if (want.layer !== undefined) expect(hit.layer).toBe(want.layer);
        if (want.description !== undefined) expect(hit.description).toMatch(want.description);
      }
    }
  });
});

const INVENTORY_LAYERS: Record<string, string> = {
  "src/util.ts": "utils",
  "src/config.yaml": "config",
  "src/types.ts": "types",
  "src/services/pay.ts": "services",
  "src/main.ts": "misc",
  "src/hub.ts": "misc",
  "src/plain.ts": "misc",
};

const HUB_SOURCE = "import a from 'a';\nimport b from 'b';\nimport c from 'c';\nimport d from 'd';\nimport e from 'e';\nexport const hub = [a, b, c, d, e];\n";

describe("writeResults", () => {
  it("records the findings, the scan scope and the file classification", () => {
    const project = projectFiles({
      "src/util.ts": 'console.log("x");\n',
      "src/config.yaml": "a: 1\n",
      "src/types.ts": "export type A = string;\ninterface B {}\n",
      "src/services/pay.ts": "export const pay = () => 1;\n",
      "src/main.ts": "export const main = () => 1;\n",
      "src/hub.ts": HUB_SOURCE,
      "src/plain.ts": "export const plain = () => 1;\n",
    });
    const audit = projectFiles({});
    const sourceFiles = Object.keys(INVENTORY_LAYERS);
    mkdirSync(join(audit, "data", "scanner-output"), { recursive: true });
    writeFileSync(
      join(audit, "data", "inventory.json"),
      JSON.stringify({ files: sourceFiles.map((path) => ({ path, layer: INVENTORY_LAYERS[path] })) }),
    );
    writeFileSync(join(audit, "data", "scanner-output", "scope-map.json"), JSON.stringify({ "scanner-1": ["a.ts"] }));
    const { findings } = scanProject(project, sourceFiles, "typescript", INVENTORY_LAYERS);

    const output = writeResults(audit, findings, sourceFiles, project);

    const outputDir = join(audit, "data", "scanner-output");
    expect(output).toBe(join(outputDir, "grep-scanner.jsonl"));
    const rows = readFileSync(output, "utf8").trimEnd().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStartWith('{"rule": "R09", "severity": "MEDIUM", "category": "clean-code", "file": "src/util.ts", "line": 1, ');
    expect(readFileSync(join(outputDir, "grep-scanner.status"), "utf8")).toBe("COMPLETE 1\n");
    expect(JSON.parse(readFileSync(join(outputDir, "scope-map.json"), "utf8"))).toEqual({ "scanner-1": ["a.ts"], "grep-scanner": sourceFiles });
    const flagged: unknown = JSON.parse(readFileSync(join(audit, "data", "flagged-files.json"), "utf8"));
    expect(flagged).toEqual({
      flagged: [{ path: "src/util.ts", layer: "utils", reason: "grep_finding" }],
      always_scan: [
        { path: "src/services/pay.ts", layer: "services", reason: "always_scan_layer:services" },
        { path: "src/main.ts", layer: "misc", reason: "entry_point_pattern" },
        { path: "src/hub.ts", layer: "misc", reason: "high_import_count" },
      ],
      structural_only: [
        { path: "src/config.yaml", layer: "config", reason: "skip_extension:.yaml" },
        { path: "src/types.ts", layer: "types", reason: "type_decl_or_reexport" },
      ],
      llm_scan: [{ path: "src/plain.ts", layer: "misc", reason: "default" }],
    });
  });
});

describe("the grep-scanner command", () => {
  it("scans the inventory's source files and prints the summary", () => {
    const project = projectFiles({ "package.json": "{}", "src/components/App.tsx": 'console.log("hello");\n' });
    const audit = projectFiles({});
    buildInventory(project, audit);

    const run = runScanner([project, audit]);

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^GREP_SCAN_COMPLETE: 1 findings from \d+ patterns across 1 files\n {2}With target_code \(removable\): 1\n {2}Needing enrichment: 0\n {2}CLN: 1\n$/,
    );
    expect(readFileSync(join(audit, "data", "scanner-output", "grep-scanner.status"), "utf8")).toBe("COMPLETE 1\n");
  });
});

const FIXTURE_PROJECT = join(import.meta.dir, "fixtures", "synthetic-project");

describe("the synthetic fixture project", () => {
  it("is scanned for every finding its expected-findings file assigns to the grep scanner", () => {
    const expected: unknown = JSON.parse(readFileSync(join(FIXTURE_PROJECT, "expected-findings.json"), "utf8"));
    const listed = isRecord(expected) && Array.isArray(expected["expected"]) ? expected["expected"] : [];
    const required = listed.filter(isRecord).filter((entry) => entry["must_be_found_by"] === "grep-scanner");
    const files = required.map((entry) => String(entry["file"]));

    const { findings } = scanProject(FIXTURE_PROJECT, files, "typescript", Object.fromEntries(files.map((file) => [file, SERVICES])));

    const found = new Set(findings.map((finding) => `${finding.rule} ${finding.file}`));
    expect(required.length).toBeGreaterThan(0);
    expect(required.map((entry) => `${String(entry["rule"])} ${String(entry["file"])}`).filter((pair) => !found.has(pair))).toEqual([]);
  });
});
