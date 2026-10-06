// Deterministic category normalization. Two strategies, in order: the rule table (the SSOT,
// which overrides whatever a scanner wrote), then a text map for rules the table lacks.
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { isPyTruthy, pyStrip, universalLines, writeTextAtomic } from "@quality/py-text.ts";

export const VALID_SEVERITIES: ReadonlySet<string> = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "REVIEW"]);

export const DEFAULT_SEVERITY = "MEDIUM";

// A finding without every one of these (truthy) cannot be fixed and is rejected.
export const REQUIRED_FIELDS: readonly string[] = ["rule", "file", "line", "description"];

const DEFAULT_CATEGORY = "clean-code";

const RULE_TO_CATEGORY: ReadonlyMap<string, string> = new Map([
  ["R01", "ssot-dry"],
  ["R02", "architecture"],
  ["R03", "architecture"],
  ["R04", "performance"],
  ["R05", "security"],
  ["R07", "typing"],
  ["R08", "full-stack"],
  ["R09", "clean-code"],
  ["R10", "refactoring"],
  ["R11", "documentation"],
  ["R12", "data-integrity"],
  ["R13", "clean-code"],
  ["R14", "build"],
  ["R16", "full-stack"],
]);

// Every known spelling, lowercase, mapped to its canonical slug.
const CATEGORY_MAP: ReadonlyMap<string, string> = new Map([
  ["security", "security"],
  ["typing", "typing"],
  ["ssot-dry", "ssot-dry"],
  ["architecture", "architecture"],
  ["clean-code", "clean-code"],
  ["performance", "performance"],
  ["data-integrity", "data-integrity"],
  ["refactoring", "refactoring"],
  ["full-stack", "full-stack"],
  ["documentation", "documentation"],
  ["build", "build"],
  ["clean code", "clean-code"],
  ["code quality", "clean-code"],
  ["code_quality", "clean-code"],
  ["code-quality", "clean-code"],
  ["codequality", "clean-code"],
  ["magic numbers", "clean-code"],
  ["magic-numbers", "clean-code"],
  ["magic_numbers", "clean-code"],
  ["no magic numbers", "clean-code"],
  ["console statement", "clean-code"],
  ["strict typing", "typing"],
  ["strict-typing", "typing"],
  ["strict_typing", "typing"],
  ["type", "typing"],
  ["type safety", "typing"],
  ["type_safety", "typing"],
  ["ssot/dry", "ssot-dry"],
  ["ssot & dry", "ssot-dry"],
  ["dry", "ssot-dry"],
  ["dry violation", "ssot-dry"],
  ["dry_violation", "ssot-dry"],
  ["duplication", "ssot-dry"],
  ["separation of concerns", "architecture"],
  ["mirror architecture", "architecture"],
  ["mirror-architecture", "architecture"],
  ["unused-imports", "build"],
  ["unused imports", "build"],
  ["clean_code", "clean-code"],
]);

export function normalizeCategory(raw: string, rule = ""): string {
  const fromRule = rule === "" ? undefined : RULE_TO_CATEGORY.get(rule);
  if (fromRule !== undefined) return fromRule;
  return CATEGORY_MAP.get(pyStrip(raw).toLowerCase()) ?? DEFAULT_CATEGORY;
}

// Validates and normalizes a finding in place; false when it lacks a required field.
// The category comes from the rule (or its text) and the severity is uppercased, an
// unknown one becoming MEDIUM.
export function validateFinding(finding: Record<string, unknown>): boolean {
  if (!REQUIRED_FIELDS.every((key) => isPyTruthy(finding[key]))) return false;
  finding["category"] = normalizeCategory(pyStr(finding["category"]), pyStr(finding["rule"]));
  const severity = (isPyTruthy(finding["severity"]) ? pyStr(finding["severity"]) : DEFAULT_SEVERITY).toUpperCase();
  finding["severity"] = VALID_SEVERITIES.has(severity) ? severity : DEFAULT_SEVERITY;
  return true;
}

// Normalizes every finding of a findings.jsonl in place, dropping those validateFinding
// rejects, and returns how many were kept.
export function normalizeFindingsFile(path: string): number {
  const kept: Record<string, unknown>[] = [];
  let rejected = 0;
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const finding: unknown = JSON.parse(stripped);
    if (!isRecord(finding)) throw new TypeError(`${path}: every row must be a JSON object`);
    if (validateFinding(finding)) kept.push(finding);
    else rejected += 1;
  }
  if (rejected > 0) console.error(`normalize: rejected ${rejected} findings with missing required fields`);
  writeTextAtomic(path, kept.map((finding) => pyJsonDumps(finding) + "\n").join(""));
  return kept.length;
}
