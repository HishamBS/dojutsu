import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { buildInventory } from "@rinnegan/create-inventory.ts";
import { buildPlan } from "@rinnegan/create-scan-plan.ts";
import type { ScanPlan } from "@quality/types.ts";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const INVENTORY_CLI = join(SCRIPTS_DIR, "create-inventory.ts");
const PLAN_CLI = join(SCRIPTS_DIR, "create-scan-plan.ts");

function runCli(script: string, args: string[]): { status: number | null; stdout: string } {
  const result = Bun.spawnSync([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

describe("buildInventory stack detection", () => {
  it.each([
    { name: "next dependency", files: { "package.json": '{"dependencies": {"next": "14"}}' }, stack: "typescript", framework: "nextjs" },
    { name: "react dev dependency", files: { "package.json": '{"devDependencies": {"react": "18"}}' }, stack: "typescript", framework: "react" },
    { name: "vue before express", files: { "package.json": '{"dependencies": {"express": "4", "vue": "3"}}' }, stack: "typescript", framework: "vue" },
    { name: "express", files: { "package.json": '{"dependencies": {"express": "4"}}' }, stack: "typescript", framework: "express" },
    { name: "malformed package.json", files: { "package.json": "{not json" }, stack: "typescript", framework: "unknown" },
    { name: "null dependencies", files: { "package.json": '{"dependencies": null}' }, stack: "typescript", framework: "unknown" },
    { name: "pyproject fastapi", files: { "pyproject.toml": "dependencies = ['FastAPI']" }, stack: "python", framework: "fastapi" },
    { name: "pyproject django", files: { "pyproject.toml": "dependencies = ['django']" }, stack: "python", framework: "django" },
    { name: "pyproject flask", files: { "pyproject.toml": "dependencies = ['flask']" }, stack: "python", framework: "flask" },
    { name: "requirements.txt only", files: { "requirements.txt": "flask\n" }, stack: "python", framework: "unknown" },
    { name: "pom.xml", files: { "pom.xml": "<project/>" }, stack: "java", framework: "unknown" },
    { name: "gradle build", files: { "build.gradle": "" }, stack: "java", framework: "unknown" },
    { name: "no manifest", files: { "README.md": "" }, stack: "unknown", framework: "unknown" },
  ])("$name", ({ files, stack, framework }) => {
    const inventory = buildInventory(projectFiles(files));
    expect([inventory.stack, inventory.framework]).toEqual([stack, framework]);
  });
});

const lines = (count: number): string => Array.from({ length: count }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
const MARKER_BODY = "const RULE_PATTERNS = [];\nconst SUPPRESSION = /@ts-nocheck/;\n";
const MAX_FILE_LOC = 10_000;

interface ClassificationCase {
  name: string;
  files: Record<string, string>;
  expected: Record<string, object>;
  totalLoc?: number;
  absent?: string[];
}

interface PlanCase {
  name: string;
  files: PlanFile[];
  batches: { layer: string; files: string[] }[];
}

describe("buildInventory file classification", () => {
  it.each<ClassificationCase>([
    {
      name: "tiny files are nominal and real files are not",
      files: { "src/tiny.ts": "export const x = 1;\n", "src/real.ts": lines(50) },
      expected: { "src/tiny.ts": { loc: 1, nominal: true }, "src/real.ts": { loc: 50, nominal: false } },
      totalLoc: 51,
    },
    {
      name: "authority paths keep tiny files out of the nominal set",
      files: {
        ".rinnegan/authority-paths.txt": "# comment\npackages/shared-constants/\n\n",
        "packages/shared-constants/src/tiny-ssot.ts": "export const X = 1;\n",
        "src/tiny.ts": "export const Y = 2;\n",
      },
      expected: { "packages/shared-constants/src/tiny-ssot.ts": { nominal: false }, "src/tiny.ts": { nominal: true } },
    },
    {
      name: "meta files need directory, filename and content together",
      files: {
        "scripts/ci/enforce-engineering-rules.ts": MARKER_BODY,
        "packages/auth/src/verify-token.ts": "export function verifyToken(t: string) { return t.length > 0; }\n",
        "scripts/ci/release-publish.ts": "import { execSync } from 'node:child_process';\n",
        "packages/h1/src/cam/engine.ts": "export class Engine {}\n",
      },
      expected: {
        "scripts/ci/enforce-engineering-rules.ts": { is_meta_file: true },
        "packages/auth/src/verify-token.ts": { is_meta_file: false },
        "scripts/ci/release-publish.ts": { is_meta_file: false },
        "packages/h1/src/cam/engine.ts": { is_meta_file: false },
      },
    },
    {
      name: "layers and tags come from the path and header",
      files: {
        "src/services/auth.ts": lines(12),
        "src/components/Button.tsx": lines(12),
        "app/api/users/route.ts": lines(12),
        "src/foo.test.ts": lines(12),
        "src/generated/api.ts": lines(12),
        "src/misc.ts": lines(12),
      },
      expected: {
        "src/services/auth.ts": { layer: "services", tag: "SOURCE" },
        "src/components/Button.tsx": { layer: "components", tag: "SOURCE" },
        "app/api/users/route.ts": { layer: "api-routes", tag: "SOURCE" },
        "src/foo.test.ts": { layer: "tests", tag: "TEST" },
        "src/generated/api.ts": { layer: "misc", tag: "GENERATED", skip_reason: "Generated source file" },
        "src/misc.ts": { layer: "misc", tag: "SOURCE" },
      },
    },
    {
      name: "oversized files are tagged and skipped",
      files: { "src/huge.ts": lines(MAX_FILE_LOC + 1) },
      expected: { "src/huge.ts": { tag: "OVERSIZED", skip_reason: "Exceeds 10000 LOC limit (10001 lines)" } },
    },
    {
      name: "dependency directories and other extensions are not inventoried",
      files: { "node_modules/pkg/index.ts": "x\n", "dist/out.ts": "x\n", "src/data.json": "{}\n", "src/real.ts": lines(12) },
      expected: { "src/real.ts": { loc: 12 } },
      absent: ["node_modules/pkg/index.ts", "dist/out.ts", "src/data.json"],
    },
    {
      name: "python stack uses its layer patterns and ignores other languages",
      files: { "pyproject.toml": "", "app/routes/users.py": lines(12), "conftest.py": lines(12), "src/x.ts": lines(12) },
      expected: { "app/routes/users.py": { layer: "routes" }, "conftest.py": { layer: "tests" } },
      absent: ["src/x.ts"],
    },
    {
      name: "java stack uses its layer patterns",
      files: { "pom.xml": "<project/>", "src/main/java/app/UserController.java": lines(12), "src/main/java/app/dto/UserDto.java": lines(12) },
      expected: { "src/main/java/app/UserController.java": { layer: "controllers" }, "src/main/java/app/dto/UserDto.java": { layer: "dto" } },
    },
  ])("$name", ({ files, expected, totalLoc, absent }) => {
    const inventory = buildInventory(projectFiles(files));
    const byPath = new Map(inventory.files.map((file) => [file.path, file]));
    for (const [path, fields] of Object.entries(expected)) expect(byPath.get(path)).toMatchObject(fields);
    for (const path of absent ?? []) expect(byPath.has(path)).toBe(false);
    if (totalLoc !== undefined) expect(inventory.total_loc).toBe(totalLoc);
  });
});

interface PlanFile {
  path: string;
  loc: number;
  layer: string;
  tag: string;
  nominal: boolean;
  is_meta_file: boolean;
}

const entry = (path: string, overrides: Partial<PlanFile> = {}): PlanFile => ({
  path,
  loc: 200,
  layer: "misc",
  tag: "SOURCE",
  nominal: false,
  is_meta_file: false,
  ...overrides,
});

function planFor(inventory: { files: PlanFile[]; total_loc: number }): { audit: string; plan: ScanPlan } {
  const audit = projectFiles({ "data/inventory.json": JSON.stringify(inventory) });
  const saved = { home: process.env["HOME"], configDir: process.env["DOJUTSU_CONFIG"] };
  process.env["HOME"] = projectFiles({ ".keep": "" });
  delete process.env["DOJUTSU_CONFIG"];
  try {
    return { audit, plan: buildPlan(audit) };
  } finally {
    if (saved.home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved.home;
    if (saved.configDir !== undefined) process.env["DOJUTSU_CONFIG"] = saved.configDir;
  }
}

const manyFiles = Array.from({ length: 31 }, (_, i) => entry(`src/f${i + 1}.ts`));

describe("buildPlan", () => {
  it.each<PlanCase>([
    {
      name: "nominal files stay out of the batches",
      files: [entry("src/tiny.ts", { loc: 1, nominal: true }), entry("src/real.ts")],
      batches: [{ layer: "misc", files: ["src/real.ts"] }],
    },
    {
      name: "meta files stay out of the batches",
      files: [entry("scripts/ci/enforce-rules.ts", { layer: "config", is_meta_file: true }), entry("src/real.ts")],
      batches: [{ layer: "misc", files: ["src/real.ts"] }],
    },
    {
      name: "oversized and generated files stay out of the batches",
      files: [entry("src/huge.ts", { tag: "OVERSIZED" }), entry("src/api.ts", { tag: "GENERATED" }), entry("src/real.ts")],
      batches: [{ layer: "misc", files: ["src/real.ts"] }],
    },
    {
      name: "a batch takes its layer from its own first file, not the filtered-out entry",
      files: [entry("src/tiny-config.ts", { loc: 1, layer: "config", nominal: true }), entry("src/real-service.ts", { layer: "services" })],
      batches: [{ layer: "services", files: ["src/real-service.ts"] }],
    },
    {
      name: "files split at the default batch size of thirty",
      files: manyFiles,
      batches: [
        { layer: "misc", files: manyFiles.slice(0, 30).map((file) => file.path) },
        { layer: "misc", files: ["src/f31.ts"] },
      ],
    },
    { name: "no eligible files give an empty plan", files: [entry("src/tiny.ts", { loc: 1, nominal: true })], batches: [] },
  ])("$name", ({ files, batches }) => {
    const { audit, plan } = planFor({ files, total_loc: files.reduce((sum, file) => sum + file.loc, 0) });
    const expected = {
      total_batches: batches.length,
      completed: 0,
      batches: batches.map((batch, index) => ({
        id: index + 1,
        layer: batch.layer,
        files: batch.files,
        status: "pending",
        output_file: `data/scanner-output/scanner-${index + 1}-${batch.layer}.jsonl`,
        finding_count: 0,
      })),
    };
    expect(plan).toEqual(expected);
    expect(JSON.parse(readFileSync(join(audit, "data", "scan-plan.json"), "utf8"))).toEqual(expected);
  });
});

describe("create-scan-plan CLI", () => {
  it("writes scan-plan.json and reports the batches and skipped files", () => {
    const files = [entry("src/real.ts"), entry("src/huge.ts", { tag: "OVERSIZED" }), entry("src/api.ts", { tag: "GENERATED" })];
    const audit = projectFiles({ "data/inventory.json": JSON.stringify({ files, total_loc: 600 }) });

    const { status, stdout } = runCli(PLAN_CLI, [audit]);

    expect(status).toBe(0);
    expect(stdout).toBe("Created scan plan: 1 batches for 1 files (skipped 2 OVERSIZED/GENERATED)\n");
    expect(existsSync(join(audit, "data", "scan-plan.json"))).toBe(true);
  });
});

describe("create-inventory CLI", () => {
  it("writes the inventory and scope map and reports the stack, files and layers", () => {
    const project = projectFiles({
      "package.json": '{"name": "fixture"}',
      "client.ts": "// Generated by h1\nexport const value = 1;\n",
    });
    const audit = join(project, "audit");

    const { status, stdout } = runCli(INVENTORY_CLI, [project, audit]);

    expect(status).toBe(0);
    const inventory = JSON.parse(readFileSync(join(audit, "data", "inventory.json"), "utf8")) as {
      files: { tag: string; skip_reason?: string }[];
    };
    expect(inventory.files[0]?.tag).toBe("GENERATED");
    expect(inventory.files[0]?.skip_reason).toBe("Generated source file");
    expect(readFileSync(join(audit, "data", "scanner-output", "scope-map.json"), "utf8")).toBe("{}");
    for (const dir of ["data/tasks", "layers", "phases"]) expect(existsSync(join(audit, dir))).toBe(true);
    expect(stdout.split("\n")).toEqual([
      "Stack: typescript/unknown",
      "Files: 1, LOC: 2, Layers: 1",
      "  misc: 1 files, 2 LOC",
      `Output: ${audit}/data/inventory.json`,
      `Directories created: ${audit}/{data,layers,phases}`,
      "",
    ]);
  });
});
