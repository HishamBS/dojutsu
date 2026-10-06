#!/usr/bin/env bun
// Deterministically collapses repeat structural findings into root-cause families: one root
// finding per family keeps its severity, the others are demoted one step and point at it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { pyStrip, universalLines } from "@quality/py-text.ts";

type Row = Record<string, unknown>;
export type FamilyResult = { families_created: number; root_causes: number; subordinate_findings: number; family_ids: string[] };

export const SEVERITY_ORDER: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, REVIEW: 4 };

const DEMOTION_MAP: Readonly<Record<string, string>> = { CRITICAL: "HIGH", HIGH: "MEDIUM", MEDIUM: "LOW", LOW: "LOW", REVIEW: "REVIEW" };
const ROOT_CAUSE_RULES: ReadonlySet<string> = new Set(["R01"]);
const MIN_DISTINCT_FILES = 2;
const DEFAULT_SEVERITY = "MEDIUM";
const DEFAULT_PHASE = 10;
const UNKNOWN_SEVERITY_RANK = 99;
const FAMILY_FIELDS: readonly string[] = ["family_id", "parent_finding_id", "is_root_cause"];

function loadJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  const rows: Row[] = [];
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) throw new TypeError(`${path}: every row must be a JSON object`);
    rows.push(parsed);
  }
  return rows;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value
    .toLowerCase()
    .replace(/`[^`]+`/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b\d+\b/g, " ");
  return text.split(" ").filter((word) => word !== "").join(" ");
}

function patternKey(finding: Row): string {
  for (const field of ["search_pattern", "current_code", "snippet", "description"]) {
    const normalized = normalizeText(finding[field]);
    if (normalized !== "") return normalized;
  }
  return normalizeText(finding["id"] ?? "");
}

const isSeverity = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(SEVERITY_ORDER, value);

function severityForSort(finding: Row): string {
  const original = finding["original_severity"];
  if (isSeverity(original)) return original;
  const severity = pyStr(finding["severity"] ?? DEFAULT_SEVERITY);
  return isSeverity(severity) ? severity : DEFAULT_SEVERITY;
}

// int(value) for a JSON value, or the fallback when Python's int() would raise.
function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

type RootSortKey = [severity: number, phase: number, file: string, line: number, id: string];

function rootSortKey(finding: Row): RootSortKey {
  return [
    SEVERITY_ORDER[severityForSort(finding)] ?? UNKNOWN_SEVERITY_RANK,
    toInt(finding["phase"] ?? DEFAULT_PHASE, DEFAULT_PHASE),
    pyStr(finding["file"]),
    toInt(finding["line"] ?? 0, 0),
    pyStr(finding["id"]),
  ];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRootKeys(a: RootSortKey, b: RootSortKey): number {
  return a[0] - b[0] || a[1] - b[1] || compareText(a[2], b[2]) || a[3] - b[3] || compareText(a[4], b[4]);
}

function clearFamilyFields(finding: Row): void {
  for (const field of FAMILY_FIELDS) delete finding[field];
  const original = finding["original_severity"];
  if (isSeverity(original)) finding["severity"] = original;
  delete finding["original_severity"];
}

type Candidate = { rule: string; pattern: string; members: Row[] };

function familyCandidates(findings: readonly Row[]): Candidate[] {
  const groups = new Map<string, Candidate>();
  for (const finding of findings) {
    const rule = pyStrip(pyStr(finding["rule"]));
    if (!ROOT_CAUSE_RULES.has(rule) || pyStr(finding["severity"]) === "REVIEW") continue;
    const pattern = patternKey(finding);
    if (pattern === "") continue;
    const key = `${rule}\u0000${pattern}`;
    const group = groups.get(key) ?? { rule, pattern, members: [] };
    group.members.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const lowestRootKey = (members: readonly Row[]): RootSortKey => members.map(rootSortKey).sort(compareRootKeys)[0] ?? [UNKNOWN_SEVERITY_RANK, DEFAULT_PHASE, "", 0, ""];

export function collapseFindingFamilies(auditDir: string): FamilyResult {
  const findingsPath = join(auditDir, "data", "findings.jsonl");
  const findings = loadJsonl(findingsPath);
  if (findings.length === 0) return { families_created: 0, root_causes: 0, subordinate_findings: 0, family_ids: [] };

  for (const finding of findings) clearFamilyFields(finding);

  const ordered = familyCandidates(findings).sort(
    (a, b) => compareText(a.rule, b.rule) || compareText(a.pattern, b.pattern) || compareRootKeys(lowestRootKey(a.members), lowestRootKey(b.members)),
  );
  const families: Row[] = [];
  let familyIndex = 1;

  for (const { pattern, members } of ordered) {
    const distinctFiles = [...new Set(members.map((member) => pyStr(member["file"])).filter((file) => file !== ""))].sort(compareText);
    if (distinctFiles.length < MIN_DISTINCT_FILES) continue;

    const sorted = [...members].sort((a, b) => compareRootKeys(rootSortKey(a), rootSortKey(b)));
    const [root, ...subordinates] = sorted;
    if (root === undefined) continue;
    const familyId = `FAM-${String(familyIndex).padStart(3, "0")}`;
    familyIndex += 1;

    root["family_id"] = familyId;
    root["is_root_cause"] = true;
    const subordinateIds: string[] = [];
    for (const subordinate of subordinates) {
      const originalSeverity = severityForSort(subordinate);
      subordinate["family_id"] = familyId;
      subordinate["parent_finding_id"] = root["id"] ?? "";
      subordinate["is_root_cause"] = false;
      subordinate["original_severity"] = originalSeverity;
      subordinate["severity"] = DEMOTION_MAP[originalSeverity] ?? "LOW";
      subordinateIds.push(pyStr(subordinate["id"]));
    }
    families.push({
      id: familyId,
      rule: root["rule"] ?? "",
      pattern_key: pattern,
      root_finding_id: root["id"] ?? "",
      root_severity: severityForSort(root),
      member_finding_ids: sorted.map((member) => pyStr(member["id"])),
      subordinate_finding_ids: subordinateIds,
      distinct_files: distinctFiles,
      family_size: sorted.length,
      description: pyStr(root["description"]),
    });
  }

  writeFileSync(findingsPath, findings.map((finding) => pyJsonDumps(finding) + "\n").join(""));
  const subordinateTotal = families.reduce((sum, family) => sum + (Array.isArray(family["subordinate_finding_ids"]) ? family["subordinate_finding_ids"].length : 0), 0);
  const familiesPath = join(auditDir, "data", "finding-families.json");
  mkdirSync(dirname(familiesPath), { recursive: true });
  writeFileSync(
    familiesPath,
    dumpJson({ families, summary: { families_created: families.length, root_causes: families.length, subordinate_findings: subordinateTotal } }) + "\n",
  );
  return {
    families_created: families.length,
    root_causes: families.length,
    subordinate_findings: subordinateTotal,
    family_ids: families.map((family) => pyStr(family["id"])),
  };
}

if (import.meta.main) {
  const auditDir = process.argv[2];
  if (auditDir === undefined) {
    console.log("Usage: finding_families.ts <audit_dir>");
    process.exit(1);
  }
  const result = collapseFindingFamilies(resolve(auditDir));
  console.log(`FAMILY_COLLAPSE_COMPLETE families=${result.families_created} subordinates=${result.subordinate_findings}`);
}
