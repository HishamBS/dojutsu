// Deterministic finding aggregation: validated scanner output to data/findings.jsonl. Every
// step is fixed by its inputs, so no agent runs here; the pipeline has already validated and
// normalized each scanner file.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { pyStrip, universalLines, writeTextAtomic } from "@quality/py-text.ts";
import { SEVERITY_ORDER } from "@rinnegan/finding_families.ts";
import { CATEGORY_PREFIX, loadInventory } from "@rinnegan/grep_scanner_lib.ts";

type Row = Record<string, unknown>;

const NEAR_DUPLICATE_LINE_WINDOW = 5; // Rule 3: lines this close can restate one violation
const NEAR_DUPLICATE_MIN_SHARED_WORDS = 4; // Rule 3: descriptions must share this many words
const DESCRIPTION_STOP_WORDS: ReadonlySet<string> = new Set(["the", "a", "is", "in", "of"]); // never count as shared
const WORD_RE = /[a-z0-9_]+/g;
const ID_DIGITS = 3;

function readFindings(scannerFiles: readonly string[]): Row[] {
  const findings: Row[] = [];
  for (const path of scannerFiles) {
    for (const line of universalLines(readTextStrict(path))) {
      if (pyStrip(line) === "") continue;
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError(`${path}: every row must be a JSON object`);
      findings.push(parsed);
    }
  }
  return findings;
}

const scannersOf = (finding: Row): Set<string> =>
  new Set(
    pyStr(finding["scanner"])
      .split(",")
      .map((name) => pyStrip(name))
      .filter((name) => name !== ""),
  );

function credit(finding: Row, scanners: ReadonlySet<string>): void {
  if (scanners.size > 0) finding["scanner"] = [...scanners].sort().join(",");
}

function severityRank(finding: Row): number {
  const severity = finding["severity"];
  const rank = typeof severity === "string" ? SEVERITY_ORDER[severity] : undefined;
  if (rank === undefined) throw new TypeError(`unknown severity ${pyStr(severity)} on ${pyStr(finding["file"])}:${pyStr(finding["line"])}`);
  return rank;
}

const explanationLength = (finding: Row): number => [...pyStr(finding["explanation"])].length;

// Rule 1's ranking: higher severity first, then the longer explanation.
const stronger = (a: Row, b: Row): boolean => severityRank(a) < severityRank(b) || (severityRank(a) === severityRank(b) && explanationLength(a) > explanationLength(b));

// Rule 1: one finding per (file, line, rule), crediting every scanner that reported it.
// Different rules at the same line are separate violations, so the rule is part of the key.
function dedupeSameLocation(findings: readonly Row[]): Row[] {
  const kept = new Map<string, Row>();
  const credited = new Map<string, Set<string>>();
  for (const finding of findings) {
    const key = JSON.stringify([finding["file"], finding["line"], finding["rule"]]);
    const names = credited.get(key) ?? new Set<string>();
    for (const name of scannersOf(finding)) names.add(name);
    credited.set(key, names);
    const current = kept.get(key);
    if (current === undefined || stronger(finding, current)) kept.set(key, finding);
  }
  for (const [key, finding] of kept) credit(finding, credited.get(key) ?? new Set());
  return [...kept.values()];
}

const descriptionWords = (finding: Row): Set<string> =>
  new Set([...pyStr(finding["description"]).toLowerCase().matchAll(WORD_RE)].map((match) => match[0]).filter((word) => !DESCRIPTION_STOP_WORDS.has(word)));

const lineOf = (finding: Row): number => {
  const line = finding["line"];
  if (typeof line !== "number") throw new TypeError(`line must be a number on ${pyStr(finding["file"])}`);
  return line;
};

// Rule 3: a finding at or below kept's line restates it when the lines are close and the
// descriptions share enough words.
function restates(kept: Row, finding: Row): boolean {
  const keptWords = descriptionWords(kept);
  const shared = [...descriptionWords(finding)].filter((word) => keptWords.has(word)).length;
  return lineOf(finding) - lineOf(kept) <= NEAR_DUPLICATE_LINE_WINDOW && shared >= NEAR_DUPLICATE_MIN_SHARED_WORDS;
}

const endLineOf = (finding: Row): number => {
  const end = finding["end_line"];
  return typeof end === "number" && end !== 0 ? end : lineOf(finding);
};

// Merges a restatement into kept, which holds the lower line and so the edit anchor.
function absorb(kept: Row, finding: Row): void {
  kept["end_line"] = Math.max(endLineOf(kept), endLineOf(finding));
  if (severityRank(finding) < severityRank(kept)) kept["severity"] = finding["severity"];
  if (explanationLength(finding) > explanationLength(kept)) kept["explanation"] = finding["explanation"];
  const ours = pyStr(kept["snippet"]);
  const theirs = pyStr(finding["snippet"]);
  if (!ours.includes(theirs)) kept["snippet"] = theirs.includes(ours) ? theirs : `${ours}\n${theirs}`;
  credit(kept, new Set([...scannersOf(kept), ...scannersOf(finding)]));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Rule 3: merge nearby restatements of one violation. Only findings with the same rule, file
// and search_pattern are candidates: the pattern is rasengan's edit anchor, so a different
// pattern is a different violation and both stay.
function mergeRestatements(findings: readonly Row[]): Row[] {
  const merged: Row[] = [];
  const lastKept = new Map<string, Row>();
  const ordered = [...findings].sort(
    (a, b) => compareText(pyStr(a["file"]), pyStr(b["file"])) || compareText(pyStr(a["rule"]), pyStr(b["rule"])) || lineOf(a) - lineOf(b),
  );
  for (const finding of ordered) {
    const pattern = finding["search_pattern"];
    const key = JSON.stringify([finding["file"], finding["rule"], pattern]);
    const kept = lastKept.get(key);
    if (typeof pattern === "string" && pattern !== "" && kept !== undefined && restates(kept, finding)) {
      absorb(kept, finding);
      continue;
    }
    lastKept.set(key, finding);
    merged.push(finding);
  }
  return merged;
}

// (phase, file, line, rule, description). Validation does not require a phase, so a finding
// without one sorts after every phased finding instead of breaking the sort.
function idOrder(a: Row, b: Row): number {
  const phaseA = typeof a["phase"] === "number" ? a["phase"] : Infinity;
  const phaseB = typeof b["phase"] === "number" ? b["phase"] : Infinity;
  if (phaseA !== phaseB) return phaseA < phaseB ? -1 : 1;
  return (
    compareText(pyStr(a["file"]), pyStr(b["file"])) ||
    lineOf(a) - lineOf(b) ||
    compareText(pyStr(a["rule"]), pyStr(b["rule"])) ||
    compareText(pyStr(a["description"]), pyStr(b["description"]))
  );
}

// Sort, then number each category prefix from 001: SEC-001, SEC-002, TYP-001, ...
function assignIds(findings: readonly Row[]): Row[] {
  const ordered = [...findings].sort(idOrder);
  const counters = new Map<string, number>();
  for (const finding of ordered) {
    const category = pyStr(finding["category"]);
    const prefix = CATEGORY_PREFIX[category];
    if (prefix === undefined) throw new TypeError(`category ${category} has no id prefix; validate the scanner output first`);
    const count = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, count);
    finding["id"] = `${prefix}-${String(count).padStart(ID_DIGITS, "0")}`;
  }
  return ordered;
}

// Aggregates data/scanner-output/*.jsonl into data/findings.jsonl and returns the count.
// Also writes the metadata-only data/config.json and, last, the findings.jsonl.done sentinel
// that tells the pipeline the findings file is complete.
export function aggregate(auditDir: string): number {
  const dataDir = join(auditDir, "data");
  const outputDir = join(dataDir, "scanner-output");
  const scannerFiles = readdirSync(outputDir)
    .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
    .sort(compareText)
    .map((name) => join(outputDir, name));
  const merged = mergeRestatements(dedupeSameLocation(readFindings(scannerFiles)));
  // Validation rejected every file the inventory does not list, so each one has a layer.
  const { fileToLayer } = loadInventory(auditDir);
  for (const finding of merged) {
    const layer = fileToLayer[pyStr(finding["file"])];
    if (layer === undefined) throw new TypeError(`${pyStr(finding["file"])} is not in the inventory; validate the scanner output first`);
    finding["layer"] = layer;
  }
  const findings = assignIds(merged);

  const findingsPath = join(dataDir, "findings.jsonl");
  writeTextAtomic(findingsPath, findings.map((finding) => pyJsonDumps(finding) + "\n").join(""));

  const inventory: unknown = JSON.parse(readTextStrict(join(dataDir, "inventory.json")));
  if (!isRecord(inventory)) throw new TypeError("inventory.json: expected a JSON object");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "config.json"),
    dumpJson({ stack: inventory["stack"] ?? "unknown", framework: inventory["framework"] ?? "unknown", project: inventory["root"] ?? "unknown" }) + "\n",
  );
  writeFileSync(`${findingsPath}.done`, dumpJson({ lines: findings.length, scanner_files_processed: scannerFiles.length, timestamp: nowIso() }) + "\n");
  return findings.length;
}
