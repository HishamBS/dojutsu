// Normalizers for the remaining tools: jscpd, knip, madge, radon, vulture, gitleaks, pip-audit
// and Bun's advisory audit. The same contract as the primary parsers: findings in the
// findings.jsonl shape, and a shape the tool should never produce throws.
import { isAbsolute, relative } from "node:path";
import { isRecord } from "@quality/io.ts";
import type { Finding } from "@quality/types.ts";
import { makeFinding, requireArray, requireRecord, splitLines } from "@rinnegan/tool-parsers/primary.ts";

const JSCPD_MEDIUM_LINES = 20;
const RADON_MIN_COMPLEXITY = 10;
const RADON_HIGH_COMPLEXITY = 20;
const VULTURE_HIGH_CONFIDENCE = 90;
const MAX_AUDIT_TITLES = 3;
const PIP_AUDIT_DESCRIPTION_CHARS = 200;
const AUDIT_SEVERITIES: readonly string[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const VULTURE_LINE = /^(.+?):(\d+): unused (\w+) '(.+?)' \((\d+)% confidence\)$/;

type Json = Record<string, unknown>;

// dict.get(key, fallback) for a text field.
function textField(owner: Json, key: string, fallback: string, where: string): string {
  const value = owner[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new TypeError(`${where}: ${key} is not a string`);
  return value;
}

// dict.get(key, fallback) for a numeric field.
function numberField(owner: Json, key: string, fallback: number, where: string): number {
  const value = owner[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new TypeError(`${where}: ${key} is not a number`);
  return value;
}

// dict.get(key, {}) for a nested object.
function objectField(owner: Json, key: string, where: string): Json {
  const value = owner[key];
  return value === undefined ? {} : requireRecord(value, `${where}: ${key}`);
}

// dict.get(key, []) for a list.
function listField(owner: Json, key: string, where: string): unknown[] {
  const value = owner[key];
  return value === undefined ? [] : requireArray(value, `${where}: ${key}`);
}

const relativeIfAbsolute = (projectDir: string, path: string): string => (isAbsolute(path) ? relative(projectDir, path) : path);

// Parse tool output that is allowed to be unparsable: nothing came out, so nothing is reported.
export function parseJsonOrNothing(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function parseJscpd(report: unknown): Finding[] {
  return listField(requireRecord(report, "jscpd report"), "duplicates", "jscpd report").map((value) => {
    const dup = requireRecord(value, "jscpd duplicate");
    const first = objectField(dup, "firstFile", "jscpd duplicate");
    const second = objectField(dup, "secondFile", "jscpd duplicate");
    const lines = numberField(dup, "lines", 0, "jscpd duplicate");
    const firstName = textField(first, "name", "", "jscpd firstFile");
    const secondName = textField(second, "name", "", "jscpd secondFile");
    return makeFinding({
      rule: "R01",
      severity: lines > JSCPD_MEDIUM_LINES ? "MEDIUM" : "LOW",
      category: "ssot-dry",
      file: firstName,
      line: numberField(first, "start", 0, "jscpd firstFile"),
      snippet: `${lines} duplicated lines also in ${secondName}:${numberField(second, "start", 0, "jscpd secondFile")}`,
      description: `Code duplication: ${lines} lines duplicated between ${firstName} and ${secondName}`,
      scanner: "jscpd",
      confidence: "high",
      confidenceReason: `Deterministic: jscpd token-based clone detection (${lines} lines)`,
    });
  });
}

export function parseKnip(stdout: string): Finding[] {
  const parsed = stdout.trim() === "" ? undefined : parseJsonOrNothing(stdout);
  if (parsed === undefined) return [];
  const data = requireRecord(parsed, "knip output");
  const findings: Finding[] = [];
  for (const file of listField(data, "files", "knip output")) {
    const path = typeof file === "string" ? file : "";
    findings.push(
      makeFinding({
        rule: "R09", severity: "MEDIUM", category: "clean-code",
        file: path, line: 1,
        snippet: "Entire file is unused (not imported anywhere)",
        description: `Unused file: ${path} is not imported by any other file in the project`,
        scanner: "knip", confidence: "high",
        confidenceReason: "Deterministic: knip project-wide import analysis",
      }),
    );
  }
  for (const entry of listField(data, "exports", "knip output")) {
    if (!isRecord(entry)) continue;
    const name = textField(entry, "name", "unknown", "knip export");
    findings.push(
      makeFinding({
        rule: "R09", severity: "LOW", category: "clean-code",
        file: textField(entry, "file", "", "knip export"),
        line: numberField(entry, "line", 1, "knip export"),
        snippet: `Unused export: ${name}`,
        description: `Exported symbol '${name}' is not imported anywhere in the project`,
        scanner: "knip", confidence: "high",
        confidenceReason: "Deterministic: knip export analysis",
      }),
    );
  }
  for (const dep of listField(data, "dependencies", "knip output")) {
    const name = typeof dep === "string" ? dep : textField(requireRecord(dep, "knip dependency"), "name", "", "knip dependency");
    findings.push(
      makeFinding({
        rule: "R14", severity: "LOW", category: "build",
        file: "package.json", line: 1,
        snippet: `Unused dependency: ${name}`,
        description: `Dependency '${name}' is listed in package.json but not imported`,
        scanner: "knip", confidence: "high",
        confidenceReason: "Deterministic: knip dependency analysis",
      }),
    );
  }
  return findings;
}

export function parseMadge(stdout: string): Finding[] {
  const parsed = stdout.trim() === "" ? undefined : parseJsonOrNothing(stdout);
  if (parsed === undefined) return [];
  const findings: Finding[] = [];
  for (const cycle of requireArray(parsed, "madge output")) {
    if (!Array.isArray(cycle) || cycle.length < 2) continue;
    const files = (cycle as unknown[]).map((entry) => (typeof entry === "string" ? entry : ""));
    const chain = files.join(" -> ");
    findings.push(
      makeFinding({
        rule: "R10", severity: "MEDIUM", category: "refactoring",
        file: files[0] ?? "", line: 1,
        snippet: `Circular: ${chain}`,
        description: `Circular dependency chain: ${chain}`,
        scanner: "madge", confidence: "high",
        confidenceReason: "Deterministic: madge import graph analysis",
      }),
    );
  }
  return findings;
}

export function parseRadon(stdout: string, projectDir: string): Finding[] {
  const parsed = stdout.trim() === "" ? undefined : parseJsonOrNothing(stdout);
  if (parsed === undefined) return [];
  const findings: Finding[] = [];
  for (const [filePath, functions] of Object.entries(requireRecord(parsed, "radon output"))) {
    for (const value of requireArray(functions, `radon ${filePath}`)) {
      const func = requireRecord(value, "radon function");
      const complexity = numberField(func, "complexity", 0, "radon function");
      if (complexity < RADON_MIN_COMPLEXITY) continue;
      const name = textField(func, "name", "unknown", "radon function");
      const rank = textField(func, "rank", "C", "radon function");
      findings.push(
        makeFinding({
          rule: "R02",
          severity: complexity >= RADON_HIGH_COMPLEXITY ? "HIGH" : "MEDIUM",
          category: "architecture",
          file: relativeIfAbsolute(projectDir, filePath),
          line: numberField(func, "lineno", 1, "radon function"),
          snippet: `${name}: complexity ${complexity} (rank ${rank})`,
          description: `Function '${name}' has cyclomatic complexity ${complexity} (rank ${rank}). Consider splitting into smaller functions.`,
          scanner: "radon", confidence: "high",
          confidenceReason: `Deterministic: radon cyclomatic complexity ${complexity} (threshold ${RADON_MIN_COMPLEXITY})`,
        }),
      );
    }
  }
  return findings;
}

export function parseVulture(stdout: string, projectDir: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of splitLines(stdout)) {
    const match = VULTURE_LINE.exec(line);
    if (match === null) continue;
    const [, filePath = "", lineNumber = "", kind = "", name = "", confidence = ""] = match;
    findings.push(
      makeFinding({
        rule: "R09", severity: "LOW", category: "clean-code",
        file: relativeIfAbsolute(projectDir, filePath),
        line: Number(lineNumber),
        snippet: `unused ${kind} '${name}' (${confidence}% confidence)`,
        description: `Unused ${kind}: '${name}' appears to be dead code (${confidence}% confidence)`,
        scanner: "vulture",
        confidence: Number(confidence) < VULTURE_HIGH_CONFIDENCE ? "medium" : "high",
        confidenceReason: `Deterministic: vulture dead code detection (${confidence}% confidence)`,
      }),
    );
  }
  return findings;
}

// Only the rule, the location and the rule's description leave this function: the matched
// secret and its surrounding text never reach a finding.
export function parseGitleaks(report: unknown): Finding[] {
  if (!Array.isArray(report)) return [];
  return (report as unknown[]).map((value) => {
    const entry = requireRecord(value, "gitleaks finding");
    const description = textField(entry, "Description", "Secret detected", "gitleaks finding");
    const ruleId = textField(entry, "RuleID", "unknown", "gitleaks finding");
    return makeFinding({
      rule: "R05", severity: "CRITICAL", category: "security",
      file: textField(entry, "File", "", "gitleaks finding"),
      line: numberField(entry, "StartLine", 1, "gitleaks finding"),
      snippet: `[REDACTED] ${description}`,
      description: `Hardcoded secret detected: ${description} (rule: ${ruleId})`,
      scanner: "gitleaks", confidence: "high",
      confidenceReason: `Deterministic: gitleaks ${ruleId}`,
      toolRuleId: ruleId,
    });
  });
}

// pip-audit's own severity when it is a known level, else HIGH for a "critical" description.
function pipAuditSeverity(vuln: Json, description: string): string {
  const raw = typeof vuln["severity"] === "string" ? vuln["severity"].toUpperCase() : "";
  if (AUDIT_SEVERITIES.includes(raw)) return raw;
  return description.toLowerCase().includes("critical") ? "HIGH" : "MEDIUM";
}

export function parsePipAudit(stdout: string): Finding[] {
  const parsed = stdout.trim() === "" ? undefined : parseJsonOrNothing(stdout);
  if (parsed === undefined) return [];
  const deps = Array.isArray(parsed) ? (parsed as unknown[]) : listField(requireRecord(parsed, "pip-audit output"), "dependencies", "pip-audit output");
  const findings: Finding[] = [];
  for (const depValue of deps) {
    const dep = requireRecord(depValue, "pip-audit dependency");
    const pkg = textField(dep, "name", "unknown", "pip-audit dependency");
    const version = textField(dep, "version", "", "pip-audit dependency");
    for (const vulnValue of listField(dep, "vulns", "pip-audit dependency")) {
      const vuln = requireRecord(vulnValue, "pip-audit vulnerability");
      const vulnId = textField(vuln, "id", "", "pip-audit vulnerability");
      const description = textField(vuln, "description", `Vulnerability in ${pkg}`, "pip-audit vulnerability").slice(0, PIP_AUDIT_DESCRIPTION_CHARS);
      findings.push(
        makeFinding({
          rule: "R05", severity: pipAuditSeverity(vuln, description), category: "security",
          file: "requirements.txt", line: 1,
          snippet: `${pkg}==${version}: ${vulnId}`,
          description: `Dependency vulnerability: ${pkg}==${version} — ${vulnId}: ${description}`,
          scanner: "pip-audit", confidence: "high",
          confidenceReason: `Deterministic: pip-audit OSV database (${vulnId})`,
        }),
      );
    }
  }
  return findings;
}

// An advisory's severity as one of our levels: moderate is medium, anything unrecognised
// is medium too.
function auditSeverity(advisory: Json): string {
  const raw = (typeof advisory["severity"] === "string" && advisory["severity"] !== "" ? advisory["severity"] : "low").toUpperCase();
  if (raw === "MODERATE") return "MEDIUM";
  return AUDIT_SEVERITIES.includes(raw) ? raw : "MEDIUM";
}

// `bun audit --json` prints the registry's advisory response: package name -> advisories.
// One finding per vulnerable package, at the worst severity among its advisories.
export function parseBunAudit(data: unknown): Finding[] {
  const findings: Finding[] = [];
  for (const [pkg, advisoriesValue] of Object.entries(requireRecord(data, "bun audit output"))) {
    const advisories = requireArray(advisoriesValue, `bun audit output: ${pkg}`).map((value) => requireRecord(value, `bun audit advisory for ${pkg}`));
    if (advisories.length === 0) continue;
    const severity = advisories.map(auditSeverity).reduce((worst, next) => (AUDIT_SEVERITIES.indexOf(next) > AUDIT_SEVERITIES.indexOf(worst) ? next : worst));
    const titles = advisories.slice(0, MAX_AUDIT_TITLES).map((advisory) => textField(advisory, "title", textField(advisory, "name", "", `bun audit advisory for ${pkg}`), `bun audit advisory for ${pkg}`));
    const description = titles.join("; ") || `Vulnerability in ${pkg}`;
    findings.push(
      makeFinding({
        rule: "R05", severity, category: "security",
        file: "package.json", line: 1,
        snippet: `${pkg}: ${description}`,
        description: `Dependency vulnerability: ${pkg} — ${description}`,
        scanner: "npm-audit", confidence: "high",
        confidenceReason: `Deterministic: bun audit advisory database (${severity})`,
      }),
    );
  }
  return findings;
}
