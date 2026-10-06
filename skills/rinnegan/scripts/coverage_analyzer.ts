// Turn the coverage reports a project already has (Istanbul/c8, coverage.py, JaCoCo) into R08
// findings for uncovered functions. This does not run tests; the one command it may run is
// `coverage json`, which converts an existing .coverage data file into a report.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { runCommand } from "@quality/process.ts";
import { findElements, integerAttribute, parseXml, XmlParseError } from "@quality/xml.ts";
import { isRecord, readTextStrict } from "@quality/io.ts";
import type { Finding } from "@quality/types.ts";

const COVERAGE_JSON_TIMEOUT_MS = 60_000;
const ZERO_COVERAGE_TOLERANCE = 0.01;
const FULL_COVERAGE_PERCENT = 100.0;
const COVERAGE_PHASE = 9;
const JAVA_SOURCE_ROOT = "src/main/java";
const NO_REPORT_TEXT = "No test coverage report found. Run tests with coverage enabled.";

type CoverageParser = (projectDir: string) => Finding[] | null;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function makeCoverageFinding(file: string, line: number, description: string): Finding {
  return {
    rule: "R08",
    severity: "MEDIUM",
    category: "build",
    file,
    line,
    end_line: line,
    snippet: description,
    current_code: description,
    description,
    explanation: description,
    search_pattern: "",
    phase: COVERAGE_PHASE,
    effort: "medium",
    scanner: "coverage-analyzer",
    confidence: "high",
    confidence_reason: "Deterministic: coverage report analysis",
    tool_rule_id: "zero-coverage",
    cwe: [],
  };
}

function noReportFinding(): Finding {
  return {
    ...makeCoverageFinding("project", 1, NO_REPORT_TEXT),
    current_code: "",
    confidence_reason: "Deterministic: no coverage report detected",
    tool_rule_id: "no-coverage-report",
  };
}

// An unparsable report counts as no report; a parsable one of the wrong shape is a failure.
function readJsonReport(path: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(readTextStrict(path));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(data)) throw new TypeError(`${path}: report is not a JSON object`);
  return data;
}

function recordField(owner: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = owner[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${where}: ${key} is not an object`);
  return value;
}

function lineNumber(value: unknown, where: string): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${where}: line is not an integer`);
  return value;
}

const relativeTo = (projectDir: string, filePath: string): string => (isAbsolute(filePath) ? relative(projectDir, filePath) : filePath);

function parseIstanbul(projectDir: string): Finding[] | null {
  const reportPath = join(projectDir, "coverage", "coverage-final.json");
  if (!isFile(reportPath)) return null;
  const data = readJsonReport(reportPath);
  if (data === null) return null;
  const findings: Finding[] = [];
  for (const [filePath, fileCoverage] of Object.entries(data)) {
    if (!isRecord(fileCoverage)) throw new TypeError(`${filePath}: file coverage is not an object`);
    const fnMap = recordField(fileCoverage, "fnMap", filePath);
    const counts = recordField(fileCoverage, "f", filePath);
    for (const [fnId, count] of Object.entries(counts)) {
      if (count !== 0) continue;
      const info = fnMap[fnId] ?? {};
      if (!isRecord(info)) throw new TypeError(`${filePath}: fnMap entry ${fnId} is not an object`);
      const name = typeof info["name"] === "string" ? info["name"] : `anonymous_${fnId}`;
      const start = recordField(recordField(info, "loc", filePath), "start", filePath);
      const line = lineNumber(info["line"] ?? start["line"], filePath);
      findings.push(makeCoverageFinding(relativeTo(projectDir, filePath), line, `Function '${name}' has zero test coverage`));
    }
  }
  return findings;
}

// Convert .coverage into coverage.json when only the data file exists. Any failure to do so
// (no tool, non-zero exit, timeout) means there is no report to read.
function generateCoveragePyReport(projectDir: string, reportPath: string): boolean {
  if (!isFile(join(projectDir, ".coverage"))) return false;
  const outcome = runCommand(["coverage", "json", "-o", reportPath], { cwd: projectDir, timeoutMs: COVERAGE_JSON_TIMEOUT_MS });
  return outcome.status === "exited" && outcome.exitCode === 0 && isFile(reportPath);
}

function parseCoveragePy(projectDir: string): Finding[] | null {
  const reportPath = join(projectDir, "coverage.json");
  if (!isFile(reportPath) && !generateCoveragePyReport(projectDir, reportPath)) return null;
  const data = readJsonReport(reportPath);
  if (data === null) return null;
  const findings: Finding[] = [];
  for (const [filePath, fileInfo] of Object.entries(recordField(data, "files", reportPath))) {
    if (!isRecord(fileInfo)) throw new TypeError(`${filePath}: file entry is not an object`);
    for (const [fnName, fnData] of Object.entries(recordField(fileInfo, "functions", filePath))) {
      if (!isRecord(fnData)) throw new TypeError(`${filePath}: function ${fnName} is not an object`);
      const percent = recordField(fnData, "summary", fnName)["percent_covered"] ?? FULL_COVERAGE_PERCENT;
      if (typeof percent !== "number") throw new TypeError(`${filePath}: ${fnName} percent_covered is not a number`);
      if (percent >= ZERO_COVERAGE_TOLERANCE) continue;
      findings.push(makeCoverageFinding(relativeTo(projectDir, filePath), lineNumber(fnData["line"], fnName), `Function '${fnName}' has zero test coverage`));
    }
  }
  return findings;
}

function parseJacoco(projectDir: string): Finding[] | null {
  const reportPath = join(projectDir, "target", "site", "jacoco", "jacoco.xml");
  if (!isFile(reportPath)) return null;
  let root;
  try {
    root = parseXml(readTextStrict(reportPath));
  } catch (error) {
    if (error instanceof XmlParseError) return null;
    throw error;
  }
  const findings: Finding[] = [];
  for (const pkg of findElements(root, "package")) {
    const pkgPath = pkg.attributes["name"] ?? "";
    for (const cls of findElements(pkg, "class")) {
      const className = (cls.attributes["name"] ?? "").replaceAll("/", ".");
      const sourceFile = cls.attributes["sourcefilename"] ?? "";
      const relPath = sourceFile === "" ? className : [JAVA_SOURCE_ROOT, pkgPath, sourceFile].filter((part) => part !== "").join("/");
      for (const method of findElements(cls, "method")) {
        const methodName = method.attributes["name"] ?? "";
        const line = integerAttribute(method, "line", 1);
        for (const counter of findElements(method, "counter")) {
          if (counter.attributes["type"] !== "METHOD" || integerAttribute(counter, "covered", 0) !== 0) continue;
          const qualified = className === "" ? methodName : `${className}.${methodName}`;
          findings.push(makeCoverageFinding(relPath, line, `Method '${qualified}' has zero test coverage`));
        }
      }
    }
  }
  return findings;
}

const PARSERS: Readonly<Record<string, CoverageParser>> = {
  typescript: parseIstanbul,
  python: parseCoveragePy,
  java: parseJacoco,
};

// Findings for every uncovered function, or one advisory finding when no report exists.
export function analyzeCoverage(projectDir: string, stack: string): Finding[] {
  const parse = PARSERS[stack];
  if (parse === undefined) return [noReportFinding()];
  return parse(projectDir) ?? [noReportFinding()];
}
