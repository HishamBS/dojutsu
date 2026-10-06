// Run real linting tools and normalize their output to findings.jsonl rows. This is the
// deterministic gate: what these tools catch has no false positives. Every tool is optional;
// a missing one is skipped, never installed. Commands run as argv arrays in the project
// directory, so paths with spaces or quotes are plain data.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir, readTextStrict } from "@quality/io.ts";
import { runCommand } from "@quality/process.ts";
import type { Finding } from "@quality/types.ts";
import { detectAssertionFreeTests } from "@rinnegan/assertion_detector.ts";
import { analyzeCoverage } from "@rinnegan/coverage_analyzer.ts";
import { checkEnv } from "@rinnegan/env_checker.ts";
import {
  parseBunAudit, parseGitleaks, parseJscpd, parseJsonOrNothing, parseKnip, parseMadge, parsePipAudit, parseRadon, parseVulture,
} from "@rinnegan/tool-parsers/extended.ts";
import { own, parseCheckstyle, parseEslint, parseMypy, parseRuff, parseSemgrep, parseTsc } from "@rinnegan/tool-parsers/primary.ts";

export type ToolStatus = "success" | "skipped" | "failed" | "timeout";

export type ToolResult = {
  tool: string;
  status: ToolStatus;
  findings: Finding[];
  durationMs: number;
  error: string;
  findingCount: number;
};

// Retry and deadline policy. Both can be overridden per call; production callers do not.
export type RunOptions = { retryDelayMs?: number; timeoutMs?: number };

const MS_PER_SECOND = 1000;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 120;
const TOOL_TIMEOUT_SECONDS: Readonly<Record<string, number>> = { semgrep: 300, mypy: 180, checkstyle: 180, knip: 180 };
const PROBE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 1;
const BUN_X: readonly string[] = [process.execPath, "x", "--no-install"];
const JSCPD_MIN_TOKENS = "50";
const JSCPD_MIN_LINES = "5";
const AUDIT_FOUND_EXIT_CODE = 1;
const SCRATCH_PREFIX = "quality-skills-report-";
const BUN_LOCKFILES: readonly string[] = ["bun.lock", "bun.lockb"];

class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs / MS_PER_SECOND}s`);
    this.name = "ToolTimeoutError";
  }
}

// The tool cannot run on this project, which is not a failure and not a clean result.
class ToolSkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ToolSkippedError";
  }
}

type Runner = (projectDir: string, stack: string, timeoutMs: number) => Finding[];

// Run one command and return its stdout. The exit status is ignored on purpose: linters exit
// non-zero when they find something. An executable that cannot start, or a deadline that
// passes, is an error.
function execute(argv: readonly string[], projectDir: string, timeoutMs: number): string {
  const outcome = runCommand(argv, { cwd: projectDir, timeoutMs });
  if (outcome.status === "timeout") throw new ToolTimeoutError(timeoutMs);
  if (outcome.status === "missing") throw new Error(`cannot run ${argv[0] ?? "command"}: executable not found`);
  return outcome.stdout;
}

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();
const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

// The directory the dependency-graph tools scan: src/ when the project has one.
const sourceRoot = (projectDir: string): string => (isDirectory(join(projectDir, "src")) ? "src/" : ".");

// Run `use` with a scratch directory this call owns, removed afterwards however it ends.
function withScratch<T>(use: (scratch: string) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  try {
    return use(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A report the tool wrote into `scratch`, parsed; nothing when it wrote none or an unparsable one.
function readReport(path: string): unknown {
  return isFile(path) && statSync(path).size > 0 ? parseJsonOrNothing(readTextStrict(path)) : undefined;
}

function runBunAudit(projectDir: string, timeoutMs: number): Finding[] {
  if (!BUN_LOCKFILES.some((name) => existsSync(join(projectDir, name)))) {
    throw new ToolSkippedError(`no ${BUN_LOCKFILES[0]} in the project: bun audit has no lockfile to check`);
  }
  const outcome = runCommand([process.execPath, "audit", "--json"], { cwd: projectDir, timeoutMs });
  if (outcome.status === "timeout") throw new ToolTimeoutError(timeoutMs);
  if (outcome.status === "missing") throw new Error("cannot run bun audit: executable not found");
  const text = outcome.stdout.trim();
  const problem = (reason: string): Error => new Error(`bun audit ${reason} (exit ${outcome.exitCode}): ${outcome.stderr.trim().split("\n")[0] ?? ""}`);
  if (text === "") {
    if (outcome.exitCode === 0) return [];
    throw problem("printed no report");
  }
  const report = parseJsonOrNothing(text);
  if (report === undefined || (outcome.exitCode !== 0 && outcome.exitCode !== AUDIT_FOUND_EXIT_CODE)) throw problem("did not produce a report");
  return parseBunAudit(report);
}

function findCheckstyleJar(projectDir: string): string | null {
  const candidates = [join(homeDir(), "lib", "checkstyle.jar"), "/usr/local/lib/checkstyle.jar", join(projectDir, "tools", "checkstyle.jar")];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

function semgrepConfigs(stack: string): string[] {
  if (stack === "python") return ["p/python", "p/security-audit"];
  if (stack === "typescript") return ["p/typescript", "p/security-audit"];
  if (stack === "java") return ["p/java", "p/security-audit"];
  return ["auto"];
}

const RUNNERS: Readonly<Record<string, Runner>> = {
  eslint: (dir, _stack, timeout) => parseEslint(execute([...BUN_X, "eslint", "--format", "json", "src/"], dir, timeout), dir),
  tsc: (dir, _stack, timeout) => parseTsc(execute([...BUN_X, "tsc", "--noEmit", "--pretty", "false"], dir, timeout)),
  ruff: (dir, _stack, timeout) => parseRuff(execute(["ruff", "check", "--output-format", "json", "."], dir, timeout), dir),
  mypy: (dir, _stack, timeout) =>
    parseMypy(execute(["mypy", "--output", "json", "--ignore-missing-imports", "--check-untyped-defs", "--no-error-summary", "."], dir, timeout)),
  semgrep: (dir, stack, timeout) =>
    parseSemgrep(execute(["semgrep", "--json", "--quiet", ...semgrepConfigs(stack).flatMap((config) => ["--config", config]), "."], dir, timeout)),
  checkstyle: (dir, _stack, timeout) => {
    const jar = findCheckstyleJar(dir);
    const srcDir = join(dir, "src");
    if (jar === null || !existsSync(srcDir) || !statSync(srcDir).isDirectory()) return [];
    return parseCheckstyle(execute(["java", "-jar", jar, "-c", "/google_checks.xml", "-f", "xml", srcDir], dir, timeout), dir);
  },
  jscpd: (dir, _stack, timeout) =>
    withScratch((scratch) => {
      const argv = [...BUN_X, "jscpd", sourceRoot(dir), "--reporters", "json", "--min-tokens", JSCPD_MIN_TOKENS, "--min-lines", JSCPD_MIN_LINES, "--output", scratch];
      execute(argv, dir, timeout);
      const report = readReport(join(scratch, "jscpd-report.json"));
      return report === undefined ? [] : parseJscpd(report);
    }),
  knip: (dir, _stack, timeout) => parseKnip(execute([...BUN_X, "knip", "--reporter", "json", "--no-progress"], dir, timeout)),
  madge: (dir, _stack, timeout) => parseMadge(execute([...BUN_X, "madge", "--circular", "--json", sourceRoot(dir)], dir, timeout)),
  radon: (dir, _stack, timeout) => parseRadon(execute(["radon", "cc", ".", "-s", "-j", "--min", "C"], dir, timeout), dir),
  vulture: (dir, _stack, timeout) => parseVulture(execute(["vulture", ".", "--min-confidence", "80"], dir, timeout), dir),
  "npm-audit": (dir, _stack, timeout) => runBunAudit(dir, timeout),
  "pip-audit": (dir, _stack, timeout) => parsePipAudit(execute(["pip-audit", "--format", "json"], dir, timeout)),
  gitleaks: (dir, _stack, timeout) =>
    withScratch((scratch) => {
      const reportPath = join(scratch, "gitleaks-report.json");
      execute(["gitleaks", "detect", "--source", ".", "--no-git", "--report-format", "json", "--report-path", reportPath], dir, timeout);
      return parseGitleaks(readReport(reportPath));
    }),
  "env-check": (dir) => checkEnv(dir),
  coverage: (dir, stack) => analyzeCoverage(dir, stack),
  "assertion-check": (dir, stack) => detectAssertionFreeTests(dir, stack),
};

const timeoutFor = (tool: string, override: number | undefined): number =>
  override ?? (own(TOOL_TIMEOUT_SECONDS, tool) ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * MS_PER_SECOND;

const elapsedMs = (startedAt: number): number => Math.floor(performance.now() - startedAt);

// Run one tool with a retry, a deadline and a structured outcome. Preferred over runTool.
export async function runToolSafe(tool: string, projectDir: string, stack: string, options: RunOptions = {}): Promise<ToolResult> {
  const startedAt = performance.now();
  const runner = own(RUNNERS, tool);
  if (runner === undefined) {
    return { tool, status: "skipped", findings: [], durationMs: elapsedMs(startedAt), error: `No runner registered for tool '${tool}'`, findingCount: 0 };
  }
  const timeoutMs = timeoutFor(tool, options.timeoutMs);
  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const findings = runner(projectDir, stack, timeoutMs);
      return { tool, status: "success", findings, durationMs: elapsedMs(startedAt), error: "", findingCount: findings.length };
    } catch (error) {
      if (error instanceof ToolSkippedError) {
        return { tool, status: "skipped", findings: [], durationMs: elapsedMs(startedAt), error: error.message, findingCount: 0 };
      }
      if (error instanceof ToolTimeoutError) {
        return { tool, status: "timeout", findings: [], durationMs: elapsedMs(startedAt), error: error.message, findingCount: 0 };
      }
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt < MAX_RETRIES) await Bun.sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    }
  }
  return { tool, status: "failed", findings: [], durationMs: elapsedMs(startedAt), error: lastError, findingCount: 0 };
}

// Findings of one tool, or none when the tool is unknown or fails. Prefer runToolSafe.
export function runTool(tool: string, projectDir: string, stack: string): Promise<Finding[]> {
  const runner = own(RUNNERS, tool);
  if (runner === undefined) return Promise.resolve([]);
  try {
    return Promise.resolve(runner(projectDir, stack, timeoutFor(tool, undefined)));
  } catch {
    return Promise.resolve([]);
  }
}

type Probe = { tool: string; command: readonly string[] | null };

function probesFor(stack: string, projectDir: string): Probe[] {
  const jar = findCheckstyleJar(projectDir);
  const semgrep: Probe = { tool: "semgrep", command: ["semgrep", "--version"] };
  const jscpd: Probe = { tool: "jscpd", command: [...BUN_X, "jscpd", "--version"] };
  if (stack === "typescript") {
    return [
      { tool: "eslint", command: [...BUN_X, "eslint", "--version"] },
      { tool: "tsc", command: [...BUN_X, "tsc", "--version"] },
      semgrep,
      jscpd,
      { tool: "knip", command: [...BUN_X, "knip", "--version"] },
      { tool: "madge", command: [...BUN_X, "madge", "--version"] },
      { tool: "npm-audit", command: [process.execPath, "audit", "--help"] },
    ];
  }
  if (stack === "python") {
    return [
      { tool: "ruff", command: ["ruff", "--version"] },
      { tool: "mypy", command: ["mypy", "--version"] },
      semgrep,
      jscpd,
      { tool: "radon", command: ["radon", "--version"] },
      { tool: "vulture", command: ["vulture", "--version"] },
      { tool: "pip-audit", command: ["pip-audit", "--version"] },
    ];
  }
  if (stack === "java") {
    return [{ tool: "checkstyle", command: jar === null ? null : ["java", "-jar", jar, "--version"] }, semgrep, jscpd];
  }
  return [];
}

// A tool is available when its version probe exits 0. The probes never install anything.
export function detectTools(stack: string, projectDir: string): string[] {
  const available: string[] = [];
  const answers = (command: readonly string[]): boolean => {
    const outcome = runCommand(command, { cwd: projectDir, timeoutMs: PROBE_TIMEOUT_MS });
    return outcome.status === "exited" && outcome.exitCode === 0;
  };
  for (const probe of probesFor(stack, projectDir)) {
    if (probe.command !== null && answers(probe.command)) available.push(probe.tool);
  }
  if (answers(["gitleaks", "version"])) available.push("gitleaks");
  available.push("env-check", "coverage", "assertion-check");
  return available;
}
