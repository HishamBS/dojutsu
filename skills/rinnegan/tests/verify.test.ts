import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";

const SKILL_DIR = join(import.meta.dir, "..");
const AUDIT = "au dit \"q\" 'x'";
const SOURCE = "so urce 'y'";

function runShell(script: string, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const path = `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`;
  const result = Bun.spawnSync(["bash", join(SKILL_DIR, script), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path, ...env } });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const SEPARATOR = "=".repeat(40);
const FINDINGS = '{"id":"A-1","file":"src/f1.ts"}\n{"id":"A-2","file":"src/f2.ts"}\n{"id":"A-3","file":"src/f1.ts"}\nnot json\n';
const tsSources = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${SOURCE}/src/f${index + 1}.ts`, `export const a${index} = 1;\n`]));

interface CoverageCase {
  name: string;
  files: Record<string, string>;
  status: number | null;
  lines: string[];
}

describe("verify-coverage.sh", () => {
  it.each<CoverageCase>([
    {
      name: "matching inventory, every layer documented and the findings counted",
      files: {
        [`${AUDIT}/data/inventory.json`]: JSON.stringify({ total_files: 3, stack: "typescript", layers: { core: {}, ui: {} } }),
        [`${AUDIT}/data/findings.jsonl`]: FINDINGS,
        [`${AUDIT}/layers/core.md`]: "a\nb\n",
        [`${AUDIT}/layers/ui.md`]: "x\n",
        ...tsSources(3),
      },
      status: 0,
      lines: ["PASS: inventory (3) matches disk (3) within tolerance", "PASS: layers/core.md exists (2 lines)", "PASS: layers/ui.md exists (1 lines)", "PASS: findings reference 2 unique files", "", SEPARATOR, "VERIFY-COVERAGE: ALL CHECKS PASSED"],
    },
    {
      name: "a layer without its document fails the run",
      files: {
        [`${AUDIT}/data/inventory.json`]: JSON.stringify({ total_files: 3, stack: "typescript", layers: { core: {}, ui: {} } }),
        [`${AUDIT}/data/findings.jsonl`]: FINDINGS,
        [`${AUDIT}/layers/core.md`]: "a\nb\n",
        ...tsSources(3),
      },
      status: 1,
      lines: ["PASS: inventory (3) matches disk (3) within tolerance", "PASS: layers/core.md exists (2 lines)", "FAIL: layers/ui.md MISSING for layer 'ui'", "PASS: findings reference 2 unique files", "", SEPARATOR, "VERIFY-COVERAGE: 1 FAILURES", "  - layers/ui.md MISSING for layer 'ui'"],
    },
    {
      name: "an inventory far from the disk count is only a warning",
      files: {
        [`${AUDIT}/data/inventory.json`]: JSON.stringify({ total_files: 30, stack: "typescript", layers: { core: {} } }),
        [`${AUDIT}/data/findings.jsonl`]: FINDINGS,
        [`${AUDIT}/layers/core.md`]: "a\nb\n",
        ...tsSources(3),
      },
      status: 0,
      lines: ["WARN: inventory (30) differs from disk (3) by 27 files — possible stale inventory", "PASS: layers/core.md exists (2 lines)", "PASS: findings reference 2 unique files", "", SEPARATOR, "VERIFY-COVERAGE: ALL CHECKS PASSED"],
    },
    {
      name: "a stack with no file count skips the inventory comparison",
      files: { [`${AUDIT}/data/inventory.json`]: JSON.stringify({ total_files: 3, stack: "go", layers: { x: 1 } }), [`${AUDIT}/data/findings.jsonl`]: FINDINGS, [`${SOURCE}/.keep`]: "" },
      status: 1,
      lines: ["FAIL: layers/x.md MISSING for layer 'x'", "PASS: findings reference 2 unique files", "", SEPARATOR, "VERIFY-COVERAGE: 1 FAILURES", "  - layers/x.md MISSING for layer 'x'"],
    },
    {
      name: "missing findings are a failure of their own",
      files: { [`${AUDIT}/data/inventory.json`]: JSON.stringify({ total_files: 3, stack: "go", layers: { x: 1 } }), [`${SOURCE}/.keep`]: "" },
      status: 1,
      lines: ["FAIL: findings.jsonl not found", "FAIL: layers/x.md MISSING for layer 'x'", "", SEPARATOR, "VERIFY-COVERAGE: 2 FAILURES", "  - findings.jsonl not found", "  - layers/x.md MISSING for layer 'x'"],
    },
    { name: "a malformed inventory stops the script without output", files: { [`${AUDIT}/data/inventory.json`]: "{bad", [`${AUDIT}/data/findings.jsonl`]: FINDINGS, [`${SOURCE}/.keep`]: "" }, status: 1, lines: [] },
  ])("$name", ({ files, status, lines }) => {
    const dir = projectFiles({ ".keep": "", ...files });

    const result = runShell("verify-coverage.sh", [join(dir, AUDIT), join(dir, SOURCE)]);

    expect([result.status, result.stdout]).toEqual([status, lines.length === 0 ? "" : `${lines.join("\n")}\n`]);
  });

  it("names the directory that is missing, and needs both arguments and a bun", () => {
    const dir = projectFiles({ [`${AUDIT}/.keep`]: "", [`${SOURCE}/.keep`]: "" });

    expect(runShell("verify-coverage.sh", [join(dir, "nowhere"), join(dir, SOURCE)]).stdout).toBe(`FAIL: audit directory not found: ${join(dir, "nowhere")}\n`);
    expect(runShell("verify-coverage.sh", [join(dir, AUDIT), join(dir, "nowhere")]).stdout).toBe(`FAIL: source directory not found: ${join(dir, "nowhere")}\n`);
    expect(runShell("verify-coverage.sh", [join(dir, AUDIT)]).stderr).toContain("Usage: verify-coverage.sh <audit_dir> <source_dir>");
    const noBun = runShell("verify-coverage.sh", [join(dir, AUDIT), join(dir, SOURCE)], { PATH: "/usr/bin:/bin" });
    expect([noBun.status, noBun.stderr]).toEqual([1, "verify-coverage.sh: bun is required -- install it from https://bun.sh, then re-run\n"]);
  });
});

const finding = (id: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ id, ...fields });
const SOURCE_FILE = ["// header", ...Array.from({ length: 10 }, (_, index) => `line ${index + 2}`), "const x = 1;", "tail"].join("\n");

interface SnippetCase {
  name: string;
  findings: string[];
  sampled: string;
  details: string[];
  summary: string;
  verdict: string;
  status: number;
}

describe("verify-snippets.sh", () => {
  it.each<SnippetCase>([
    {
      name: "valid, invalid, missing-file and incomplete findings are told apart, and a high invalid share fails",
      findings: [
        finding("F-1", { file: "src/a.ts", line: 10, snippet: "const x = 1;" }),
        finding("F-2", { file: "src/a.ts", line: 10, snippet: "const y = 2;" }),
        finding("F-3", { file: "src/gone.ts", line: 3, snippet: "anything" }),
        finding("F-4", { file: "src/a.ts", line: 4 }),
      ],
      sampled: "Spot-checking 4 of 4 findings...",
      details: ["  INVALID: F-2 — snippet not found near src/a.ts:10", "  INVALID: F-3 — file not found: src/gone.ts", "  SKIP: F-4 — missing fields"],
      summary: "VERIFY-SNIPPETS: 1 valid, 2 invalid, 1 skipped (of 4 sampled)",
      verdict: "FAIL: 66% invalid (threshold: 20%)",
      status: 1,
    },
    {
      name: "every snippet found passes",
      findings: Array.from({ length: 5 }, (_, index) => finding(`F-${index}`, { file: "src/a.ts", line: 12, snippet: "const x = 1;\nsecond line" })),
      sampled: "Spot-checking 5 of 5 findings...",
      details: [],
      summary: "VERIFY-SNIPPETS: 5 valid, 0 invalid, 0 skipped (of 5 sampled)",
      verdict: "PASS: 0% invalid (within 20% threshold)",
      status: 0,
    },
    {
      name: "exactly twenty percent invalid is still a pass",
      findings: [...Array.from({ length: 4 }, (_, index) => finding(`F-${index}`, { file: "src/a.ts", line: 12, snippet: "const x = 1;" })), finding("F-9", { file: "src/a.ts", line: 12, snippet: "nope" })],
      sampled: "Spot-checking 5 of 5 findings...",
      details: ["  INVALID: F-9 — snippet not found near src/a.ts:12"],
      summary: "VERIFY-SNIPPETS: 4 valid, 1 invalid, 0 skipped (of 5 sampled)",
      verdict: "PASS: 20% invalid (within 20% threshold)",
      status: 0,
    },
    {
      name: "nothing checkable is only a warning",
      findings: [finding("F-1", { file: "src/a.ts" }), finding("F-2", { line: 4, snippet: "x" })],
      sampled: "Spot-checking 2 of 2 findings...",
      details: ["  SKIP: F-1 — missing fields", "  SKIP: F-2 — missing fields"],
      summary: "VERIFY-SNIPPETS: 0 valid, 0 invalid, 2 skipped (of 2 sampled)",
      verdict: "WARN: No findings could be checked",
      status: 0,
    },
  ])("$name", ({ findings, sampled, details, summary, verdict, status }) => {
    const dir = projectFiles({ [`${AUDIT}/data/findings.jsonl`]: `${findings.join("\n")}\n`, [`${SOURCE}/src/a.ts`]: SOURCE_FILE });

    const result = runShell("verify-snippets.sh", [join(dir, AUDIT), join(dir, SOURCE)]);

    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(sampled);
    expect(lines.filter((line) => line.startsWith("  ")).sort()).toEqual([...details].sort());
    expect(lines.slice(lines.indexOf(`${"=".repeat(40)}`))).toEqual(["=".repeat(40), summary, verdict, ""]);
    expect(result.status).toBe(status);
  });

  it("samples a tenth of the findings but at least ten and at most fifty", () => {
    const many = Array.from({ length: 600 }, (_, index) => finding(`F-${index}`, { file: "src/a.ts", line: 12, snippet: "const x = 1;" }));
    const dir = projectFiles({ [`${AUDIT}/data/findings.jsonl`]: `${many.join("\n")}\n`, [`${SOURCE}/src/a.ts`]: SOURCE_FILE });

    const result = runShell("verify-snippets.sh", [join(dir, AUDIT), join(dir, SOURCE)]);

    expect(result.stdout.split("\n")[0]).toBe("Spot-checking 50 of 600 findings...");
    expect(result.stdout).toContain("VERIFY-SNIPPETS: 50 valid, 0 invalid, 0 skipped (of 50 sampled)");
  });

  it("names what is missing, and needs both arguments and a bun", () => {
    const dir = projectFiles({ [`${AUDIT}/.keep`]: "", [`${SOURCE}/.keep`]: "" });

    expect(runShell("verify-snippets.sh", [join(dir, "nowhere"), join(dir, SOURCE)]).stdout).toBe(`FAIL: audit directory not found: ${join(dir, "nowhere")}\n`);
    expect(runShell("verify-snippets.sh", [join(dir, AUDIT), join(dir, "nowhere")]).stdout).toBe(`FAIL: source directory not found: ${join(dir, "nowhere")}\n`);
    expect(runShell("verify-snippets.sh", [join(dir, AUDIT), join(dir, SOURCE)]).stdout).toBe(`FAIL: ${join(dir, AUDIT)}/data/findings.jsonl not found\n`);
    expect(runShell("verify-snippets.sh", [join(dir, AUDIT)]).stderr).toContain("Usage: verify-snippets.sh <audit_dir> <source_dir>");
    const noBun = runShell("verify-snippets.sh", [join(dir, AUDIT), join(dir, SOURCE)], { PATH: "/usr/bin:/bin" });
    expect([noBun.status, noBun.stderr]).toEqual([1, "verify-snippets.sh: bun is required -- install it from https://bun.sh, then re-run\n"]);
  });
});

describe("verify-output.sh", () => {
  it("validates the rinnegan publication of an audit directory and passes its verdict and status through", () => {
    const dir = projectFiles({ [`${AUDIT}/.keep`]: "" });

    const result = runShell("verify-output.sh", [join(dir, AUDIT)]);

    expect(result.status).toBe(1);
    expect(result.stdout.split("\n").slice(0, 2)).toEqual(["PUBLICATION_INVALID: rinnegan", "- missing required output: master-audit.md"]);
  });

  it("needs its argument and a bun to run on", () => {
    expect(runShell("verify-output.sh", []).stderr).toContain("Usage: verify-output.sh <audit_dir>");
    const noBun = runShell("verify-output.sh", ["x"], { PATH: "/usr/bin:/bin" });
    expect([noBun.status, noBun.stderr]).toEqual([1, "verify-output.sh: bun is required -- install it from https://bun.sh, then re-run\n"]);
  });
});

const EXECUTABLE_MODE = 0o755;

interface InstallerCase {
  name: string;
  shims: string[];
  only: string;
}

describe("install-tools.sh", () => {
  it.each<InstallerCase>([
    { name: "every missing Python scanner is installed with uv alone, though pip3 and pipx are on PATH", shims: ["uv", "pipx", "pip3"], only: "uv tool install " },
    { name: "every missing JavaScript scanner is installed with bun alone, though npm is on PATH", shims: ["bun", "npm"], only: "bun install -g " },
  ])("$name", ({ shims, only }) => {
    const dir = projectFiles({ "calls.log": "" });
    const calls = join(dir, "calls.log");
    for (const name of shims) {
      const shim = join(dir, "bin", name);
      mkdirSync(dirname(shim), { recursive: true });
      writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`);
      chmodSync(shim, EXECUTABLE_MODE);
    }
    const env = { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir };

    const result = Bun.spawnSync(["bash", join(SKILL_DIR, "scripts", "install-tools.sh"), "--auto"], { env, stdout: "pipe", stderr: "pipe" });

    const installs = readFileSync(calls, "utf8").split("\n").filter((line) => line !== "");
    expect(result.exitCode).toBe(0);
    expect(installs.length).toBeGreaterThan(0);
    expect(installs.filter((line) => !line.startsWith(only))).toEqual([]);
  });
});
