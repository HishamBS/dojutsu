#!/usr/bin/env bun
// Usage: validate_scanner_output.ts <scanner_file> [inventory.json]
// Post-scanner validation: rejects unusable rows before aggregation and repairs the
// category, severity and severity ceiling of the rest, in place.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { isPyTruthy, pyStrip, universalLines, writeTextAtomic } from "@quality/py-text.ts";
import { DEFAULT_SEVERITY, normalizeCategory, REQUIRED_FIELDS, VALID_SEVERITIES } from "@rinnegan/normalize_categories.ts";

type Row = Record<string, unknown>;
export type ValidationResult = { valid: number; rejected: number; warnings: string[] };

const DENSITY_RULE_THRESHOLD = 0.6;
const DENSITY_KLOC_THRESHOLD = 20;
const LOC_PER_KLOC = 1000;
const PERCENT = 100;
const LOWEST_CONFIDENCE = "low";
const FALLBACK_SEVERITY_RANK = 2;

// Only a high-confidence finding may stay CRITICAL.
const CONFIDENCE_SEVERITY_CEILING: ReadonlyMap<string, string> = new Map([
  ["low", "MEDIUM"],
  ["medium", "HIGH"],
  ["high", "CRITICAL"],
]);
const SEVERITY_RANK: ReadonlyMap<string, number> = new Map([
  ["REVIEW", 0],
  ["LOW", 1],
  ["MEDIUM", 2],
  ["HIGH", 3],
  ["CRITICAL", 4],
]);

// format(value, ".0f"): the exact value rounded, an exact tie going to the even neighbour.
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) return rest > 0.5 ? floor + 1 : floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function applyConfidenceCeiling(finding: Row): void {
  const stated = finding["confidence"];
  let confidence = (stated === undefined ? LOWEST_CONFIDENCE : pyStr(stated)).toLowerCase();
  if (!CONFIDENCE_SEVERITY_CEILING.has(confidence)) confidence = LOWEST_CONFIDENCE;
  const ceiling = CONFIDENCE_SEVERITY_CEILING.get(confidence) ?? DEFAULT_SEVERITY;
  const current = pyStr(finding["severity"] ?? DEFAULT_SEVERITY).toUpperCase();
  if ((SEVERITY_RANK.get(current) ?? FALLBACK_SEVERITY_RANK) > (SEVERITY_RANK.get(ceiling) ?? FALLBACK_SEVERITY_RANK)) {
    finding["severity_capped_from"] = current;
    finding["severity"] = ceiling;
  }
}

function densityWarnings(valid: readonly Row[], batchLoc: number | undefined): string[] {
  const warnings: string[] = [];
  if (valid.length === 0) return warnings;
  const ruleCounts = new Map<string, number>();
  for (const finding of valid) {
    const rule = pyStr(finding["rule"]);
    ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
  }
  const total = valid.length;
  for (const [rule, count] of [...ruleCounts].sort(([, a], [, b]) => b - a)) {
    const ratio = count / total;
    if (ratio > DENSITY_RULE_THRESHOLD) {
      warnings.push(
        `Rule ${rule} produces ${count}/${total} findings (${roundHalfEven(ratio * PERCENT)}%), ` +
          `exceeding ${roundHalfEven(DENSITY_RULE_THRESHOLD * PERCENT)}% threshold. Check for over-reporting.`,
      );
    }
  }
  if (batchLoc !== undefined && batchLoc !== 0) {
    const perKloc = total / (batchLoc / LOC_PER_KLOC);
    if (perKloc > DENSITY_KLOC_THRESHOLD) {
      warnings.push(
        `${total} findings in ${batchLoc} LOC is ${roundHalfEven(perKloc)} per KLOC, above ${DENSITY_KLOC_THRESHOLD} per KLOC. ` +
          `Check for low-value findings that match a SKIP criterion.`,
      );
    }
  }
  return warnings;
}

// Rewrites scannerFile with only its valid rows and puts the rejects, each with its reason
// and line number, in <scannerFile>.rejected (removed when nothing was rejected).
export function validateScannerFile(scannerFile: string, inventoryFiles?: ReadonlySet<string>, batchLoc?: number): ValidationResult {
  const valid: Row[] = [];
  const rejected: Row[] = [];

  universalLines(readTextStrict(scannerFile)).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const stripped = pyStrip(rawLine);
    if (stripped === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      rejected.push({ _raw: stripped, _reason: "invalid_json", _line: lineNumber });
      return;
    }
    if (!isRecord(parsed)) {
      rejected.push({ _raw: stripped, _reason: "not_a_dict", _line: lineNumber });
      return;
    }
    const finding = parsed;
    const reject = (reason: string): void => {
      finding["_reason"] = reason;
      finding["_line"] = lineNumber;
      rejected.push(finding);
    };

    const missing = REQUIRED_FIELDS.filter((key) => !isPyTruthy(finding[key]));
    if (missing.length > 0) return reject(`missing_fields:${missing.join(",")}`);

    const lineValue = finding["line"];
    if (typeof lineValue !== "number" || !Number.isInteger(lineValue) || lineValue <= 0) return reject(`invalid_line_number:${pyStr(lineValue)}`);

    const filePath = pyStr(finding["file"]);
    if (inventoryFiles !== undefined && !inventoryFiles.has(filePath)) return reject(`phantom_file:${filePath}`);

    const rawCategory = pyStr(finding["category"]);
    const normalized = normalizeCategory(rawCategory, pyStr(finding["rule"]));
    if (normalized !== rawCategory) finding["category"] = normalized;

    const rawSeverity = pyStr(finding["severity"]).toUpperCase();
    finding["severity"] = VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : DEFAULT_SEVERITY;
    applyConfidenceCeiling(finding);
    valid.push(finding);
  });

  const warnings = densityWarnings(valid, batchLoc);
  writeTextAtomic(scannerFile, valid.map((finding) => pyJsonDumps(finding) + "\n").join(""));
  const rejectedPath = `${scannerFile}.rejected`;
  if (rejected.length > 0) writeFileSync(rejectedPath, rejected.map((entry) => pyJsonDumps(entry) + "\n").join(""));
  else if (existsSync(rejectedPath)) rmSync(rejectedPath);
  return { valid: valid.length, rejected: rejected.length, warnings };
}

// The file paths inventory.json lists.
export function loadInventoryFiles(inventoryPath: string): Set<string> {
  const inventory: unknown = JSON.parse(readTextStrict(inventoryPath));
  if (!isRecord(inventory)) throw new TypeError(`${inventoryPath}: expected a JSON object`);
  const files = inventory["files"] ?? [];
  if (Array.isArray(files)) {
    return new Set(files.flatMap((entry: unknown) => (isRecord(entry) && "path" in entry ? [pyStr(entry["path"])] : [])));
  }
  return isRecord(files) ? new Set(Object.keys(files)) : new Set();
}

if (import.meta.main) {
  const [scannerPath, inventoryPath] = process.argv.slice(2);
  if (scannerPath === undefined) {
    console.error("Usage: validate_scanner_output.ts <scanner_file> [inventory.json]");
    process.exit(1);
  }
  const result = validateScannerFile(scannerPath, inventoryPath === undefined ? undefined : loadInventoryFiles(inventoryPath));
  console.log(`validate: ${result.valid} valid, ${result.rejected} rejected`);
  for (const warning of result.warnings) console.log(`  WARNING: ${warning}`);
  if (result.rejected > 0) console.log(`  Rejected findings written to: ${scannerPath}.rejected`);
}
