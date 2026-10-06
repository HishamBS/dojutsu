// Normalizers for the primary linters' output: ESLint, tsc, Ruff, mypy, Semgrep and
// Checkstyle. Each takes the tool's stdout and returns findings in the findings.jsonl shape.
// A shape the tool should never produce (a message without a line) throws, which the runner
// reports as a failed tool rather than a clean result.
import { relative } from "node:path";
import { isRecord } from "@quality/io.ts";
import type { Finding } from "@quality/types.ts";
import { integerAttribute, parseXml, XmlParseError } from "@quality/xml.ts";

export type RuleMapping = readonly [rule: string, category: string, severity: string];

const SNIPPET_MAX_CHARS = 200;
const DEFAULT_PHASE = 5;
const WILDCARD_SUFFIX = "/*";

export const ESLINT_RULE_MAP: Readonly<Record<string, RuleMapping>> = {
  "no-unused-vars": ["R14", "build", "MEDIUM"],
  "react-hooks/exhaustive-deps": ["R04", "performance", "HIGH"],
  "react-hooks/rules-of-hooks": ["R04", "performance", "CRITICAL"],
  "no-console": ["R09", "clean-code", "MEDIUM"],
  "@typescript-eslint/no-explicit-any": ["R07", "typing", "HIGH"],
  "@typescript-eslint/no-non-null-assertion": ["R07", "typing", "MEDIUM"],
  "jsx-a11y/*": ["R16", "full-stack", "MEDIUM"],
};
const ESLINT_DEFAULT: RuleMapping = ["R14", "build", "MEDIUM"];

export const RUFF_RULE_MAP: Readonly<Record<string, RuleMapping>> = {
  F401: ["R14", "build", "LOW"],
  F841: ["R14", "build", "LOW"],
  E501: ["R09", "clean-code", "LOW"],
  S101: ["R05", "security", "MEDIUM"],
  S608: ["R05", "security", "HIGH"],
  S603: ["R05", "security", "HIGH"],
  B006: ["R04", "performance", "MEDIUM"],
};
const RUFF_DEFAULT: RuleMapping = ["R14", "build", "LOW"];

export const MYPY_RULE_MAP: Readonly<Record<string, RuleMapping>> = {
  assignment: ["R07", "typing", "MEDIUM"],
  "arg-type": ["R07", "typing", "MEDIUM"],
  "return-value": ["R07", "typing", "MEDIUM"],
  "name-defined": ["R14", "build", "HIGH"],
  "attr-defined": ["R07", "typing", "MEDIUM"],
  override: ["R07", "typing", "LOW"],
};
const MYPY_DEFAULT: RuleMapping = ["R07", "typing", "MEDIUM"];

const SEMGREP_SEVERITY_MAP: Readonly<Record<string, string>> = { ERROR: "HIGH", WARNING: "MEDIUM", INFO: "LOW" };
const SEMGREP_DEFAULT_SEVERITY = "LOW";

const PHASE_BY_RULE: Readonly<Record<string, number>> = {
  R14: 0, R05: 1, R07: 2, R01: 3, R02: 4, R03: 4, R09: 5, R13: 5, R04: 6, R12: 7, R10: 8, R16: 9, R08: 9, R11: 10,
};

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

export type FindingFields = {
  rule: string;
  severity: string;
  category: string;
  file: string;
  line: number;
  snippet: string;
  description: string;
  scanner: string;
  confidence: string;
  confidenceReason: string;
  toolRuleId?: string;
  cwe?: string[];
};

// A table entry by its own key: a tool-reported rule id such as "constructor" must not
// resolve to something inherited from Object.
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function phaseFromRule(rule: string): number {
  return own(PHASE_BY_RULE, rule) ?? DEFAULT_PHASE;
}

export function makeFinding(fields: FindingFields): Finding {
  return {
    rule: fields.rule,
    severity: fields.severity,
    category: fields.category,
    file: fields.file,
    line: fields.line,
    end_line: fields.line,
    snippet: fields.snippet,
    current_code: fields.snippet,
    description: fields.description,
    explanation: fields.description,
    search_pattern: "",
    phase: phaseFromRule(fields.rule),
    effort: "low",
    scanner: fields.scanner,
    confidence: fields.confidence,
    confidence_reason: fields.confidenceReason,
    tool_rule_id: fields.toolRuleId ?? "",
    cwe: fields.cwe ?? [],
  };
}

// str.splitlines for the line breaks tools emit, with no trailing empty element.
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// str() of a JSON scalar; structured values keep their JSON text.
const scalarText = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : (JSON.stringify(value) ?? "");

export const excerpt = (text: string): string => text.slice(0, SNIPPET_MAX_CHARS);

// Narrow one value of a tool's JSON to the field the normalizer needs, or fail loudly.
export function requireString(owner: Record<string, unknown>, key: string, where: string): string {
  const value = owner[key];
  if (typeof value !== "string") throw new TypeError(`${where}: ${key} is not a string`);
  return value;
}

export function requireNumber(owner: Record<string, unknown>, key: string, where: string): number {
  const value = owner[key];
  if (typeof value !== "number") throw new TypeError(`${where}: ${key} is not a number`);
  return value;
}

export function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${where}: not an object`);
  return value;
}

export function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${where}: not a list`);
  return value as unknown[];
}

export function mapEslintRule(ruleId: string): RuleMapping {
  const direct = own(ESLINT_RULE_MAP, ruleId);
  if (direct !== undefined) return direct;
  for (const [pattern, mapping] of Object.entries(ESLINT_RULE_MAP)) {
    if (pattern.endsWith(WILDCARD_SUFFIX) && ruleId.startsWith(pattern.slice(0, -1))) return mapping;
  }
  return ESLINT_DEFAULT;
}

export function parseEslint(stdout: string, projectDir: string): Finding[] {
  if (stdout.trim() === "") return [];
  const findings: Finding[] = [];
  for (const entryValue of requireArray(JSON.parse(stdout), "eslint output")) {
    const entry = requireRecord(entryValue, "eslint file entry");
    const relPath = relative(projectDir, requireString(entry, "filePath", "eslint file entry"));
    const messages = entry["messages"] === undefined ? [] : requireArray(entry["messages"], "eslint messages");
    for (const messageValue of messages) {
      const message = requireRecord(messageValue, "eslint message");
      const ruleId = typeof message["ruleId"] === "string" && message["ruleId"] !== "" ? message["ruleId"] : "parse-error";
      const [rule, category, severity] = mapEslintRule(ruleId);
      const text = requireString(message, "message", "eslint message");
      findings.push(
        makeFinding({
          rule, severity, category,
          file: relPath,
          line: requireNumber(message, "line", "eslint message"),
          snippet: excerpt(text),
          description: text,
          scanner: "eslint",
          confidence: "high",
          confidenceReason: `Deterministic: ESLint ${ruleId}`,
          toolRuleId: ruleId,
        }),
      );
    }
  }
  return findings;
}

export function parseTsc(stdout: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of splitLines(stdout)) {
    const match = TSC_LINE.exec(line);
    if (match === null) continue;
    const [, file = "", lineNumber = "", , level = "", code = "", text = ""] = match;
    const typeRelated = text.toLowerCase().includes("type");
    findings.push(
      makeFinding({
        rule: typeRelated ? "R07" : "R14",
        severity: level === "error" ? "HIGH" : "MEDIUM",
        category: typeRelated ? "typing" : "build",
        file,
        line: Number(lineNumber),
        snippet: excerpt(text),
        description: text,
        scanner: "tsc",
        confidence: "high",
        confidenceReason: `Deterministic: TypeScript ${code}`,
        toolRuleId: code,
      }),
    );
  }
  return findings;
}

export function parseRuff(stdout: string, projectDir: string): Finding[] {
  if (stdout.trim() === "") return [];
  return requireArray(JSON.parse(stdout), "ruff output").map((value) => {
    const entry = requireRecord(value, "ruff finding");
    const code = typeof entry["code"] === "string" ? entry["code"] : "";
    const [rule, category, severity] = own(RUFF_RULE_MAP, code) ?? RUFF_DEFAULT;
    const message = requireString(entry, "message", "ruff finding");
    return makeFinding({
      rule, severity, category,
      file: relative(projectDir, requireString(entry, "filename", "ruff finding")),
      line: requireNumber(requireRecord(entry["location"], "ruff location"), "row", "ruff location"),
      snippet: excerpt(message),
      description: message,
      scanner: "ruff",
      confidence: "high",
      confidenceReason: `Deterministic: Ruff ${code}`,
      toolRuleId: code,
    });
  });
}

export function parseMypy(stdout: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of splitLines(stdout)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const entry = requireRecord(parsed, "mypy line");
    if (entry["severity"] === "note") continue;
    const code = typeof entry["code"] === "string" ? entry["code"] : "";
    const [rule, category, severity] = own(MYPY_RULE_MAP, code) ?? MYPY_DEFAULT;
    const message = requireString(entry, "message", "mypy line");
    findings.push(
      makeFinding({
        rule, severity, category,
        file: requireString(entry, "file", "mypy line"),
        line: requireNumber(entry, "line", "mypy line"),
        snippet: excerpt(message),
        description: message,
        scanner: "mypy",
        confidence: "high",
        confidenceReason: `Deterministic: mypy ${code}`,
        toolRuleId: code,
      }),
    );
  }
  return findings;
}

export function parseSemgrep(stdout: string): Finding[] {
  if (stdout.trim() === "") return [];
  const data = requireRecord(JSON.parse(stdout), "semgrep output");
  const results = data["results"] === undefined ? [] : requireArray(data["results"], "semgrep results");
  return results.map((value) => {
    const result = requireRecord(value, "semgrep result");
    const extra = result["extra"] === undefined ? {} : requireRecord(result["extra"], "semgrep extra");
    const metadata = extra["metadata"] === undefined ? {} : requireRecord(extra["metadata"], "semgrep metadata");
    const cweValue = metadata["cwe"];
    const cwe = cweValue === undefined ? [] : Array.isArray(cweValue) ? (cweValue as unknown[]).map(scalarText) : [scalarText(cweValue)];
    const severityKey = typeof extra["severity"] === "string" ? extra["severity"] : "INFO";
    const security = scalarText(metadata["category"] ?? "").toLowerCase().includes("security");
    const checkId = requireString(result, "check_id", "semgrep result");
    return makeFinding({
      rule: security ? "R05" : "R14",
      severity: own(SEMGREP_SEVERITY_MAP, severityKey) ?? SEMGREP_DEFAULT_SEVERITY,
      category: security ? "security" : "build",
      file: requireString(result, "path", "semgrep result"),
      line: requireNumber(requireRecord(result["start"], "semgrep start"), "line", "semgrep start"),
      snippet: excerpt(typeof extra["lines"] === "string" ? extra["lines"] : ""),
      description: typeof extra["message"] === "string" ? extra["message"] : "",
      scanner: "semgrep",
      confidence: "high",
      confidenceReason: `Deterministic: Semgrep ${checkId}`,
      toolRuleId: checkId,
      cwe,
    });
  });
}

export function parseCheckstyle(stdout: string, projectDir: string): Finding[] {
  if (stdout.trim() === "") return [];
  let root;
  try {
    root = parseXml(stdout);
  } catch (error) {
    if (error instanceof XmlParseError) return [];
    throw error;
  }
  const findings: Finding[] = [];
  for (const fileElement of root.children.filter((child) => child.name === "file")) {
    const filePath = relative(projectDir, fileElement.attributes["name"] ?? "");
    for (const error of fileElement.children.filter((child) => child.name === "error")) {
      const source = error.attributes["source"] ?? "";
      const shortRule = source === "" ? "unknown" : (source.split(".").pop() ?? "unknown");
      const javadoc = source.toLowerCase().includes("javadoc");
      const message = error.attributes["message"] ?? "";
      findings.push(
        makeFinding({
          rule: javadoc ? "R11" : "R14",
          severity: (error.attributes["severity"] ?? "warning") === "error" ? "HIGH" : "LOW",
          category: javadoc ? "documentation" : "build",
          file: filePath,
          line: integerAttribute(error, "line", 0),
          snippet: excerpt(message),
          description: message,
          scanner: "checkstyle",
          confidence: "high",
          confidenceReason: `Deterministic: Checkstyle ${shortRule}`,
          toolRuleId: shortRule,
        }),
      );
    }
  }
  return findings;
}
