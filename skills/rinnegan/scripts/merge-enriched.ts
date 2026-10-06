#!/usr/bin/env bun
// Usage: merge-enriched.ts <audit_dir>
// Merges the enriched findings back into data/findings.jsonl with safety checks: the merged
// candidate is built, verified and normalized beside the original, and replaces it only once
// it passes, so a failed merge leaves the original bytes untouched.
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";
import { applyCrossCutting } from "@rinnegan/detect_cross_cutting.ts";
import { normalizeFindingsFile } from "@rinnegan/normalize_categories.ts";

type Row = Record<string, unknown>;
export type MergeResult = { count: number; previousCount: number; normalized: number; groups: number };

const CROSS_CUTTING_MIN_FILES = 3;

// Thrown when the enriched files hold fewer findings than the file they would replace.
export class EnrichmentLossError extends Error {
  constructor(
    readonly count: number,
    readonly previousCount: number,
  ) {
    super(`Lost ${previousCount - count} findings: ${count} enriched against ${previousCount} before`);
  }
}

type Decision = readonly [applies: (desc: string) => boolean, confidence: string, reason: string];

const mentions =
  (...keywords: string[]) =>
  (desc: string): boolean =>
    keywords.some((keyword) => desc.includes(keyword));
const always = (): boolean => true;

// The first decision whose test passes names the confidence, per rule. A rule without a
// table is precise by nature.
const CONFIDENCE_DECISIONS: Readonly<Record<string, readonly Decision[]>> = {
  R04: [
    [mentions(".map(", "loop", "n+1", "foreach"), "high", "HIGH: performance issue in loop/iterator (R04-H1/H3)"],
    [mentions("useeffect", "missing dep", "stale", "infinite"), "high", "HIGH: useEffect dependency issue (R04-H2)"],
    [(desc) => mentions("inline", "handler")(desc) && desc.includes("prop"), "high", "HIGH: inline value breaks memoization (R04-H4)"],
    [mentions("inline", "handler"), "medium", "MEDIUM: inline handler (R04-M1)"],
    [mentions("type assertion", "as record", "as unknown"), "high", "HIGH: unsafe type assertion (R07 cross-rule)"],
    [mentions("duplicate", "regex", "large", "usememo", "usecallback"), "medium", "MEDIUM: memoization opportunity (R04-M2/M3)"],
    [mentions("react.memo", "memo"), "low", "LOW: general memoization suggestion (R04-L1)"],
    [always, "medium", "MEDIUM: performance pattern (R04-M3)"],
  ],
  R11: [
    [mentions("hook", "side effect", ">3 param", "complex"), "high", "HIGH: complex export without JSDoc (R11-H1/H2)"],
    [mentions("component", "prop", "forwardref"), "medium", "MEDIUM: component without JSDoc (R11-M1)"],
    [mentions("context", "provider"), "medium", "MEDIUM: provider without JSDoc (R11-M2)"],
    [always, "low", "LOW: simple export without JSDoc (R11-L1)"],
  ],
  R13: [
    [mentions("business", "timeout", "limit", "retry", "threshold"), "high", "HIGH: business logic constant (R13-H1)"],
    [mentions("duplicate", "appears in", "ssot"), "high", "HIGH: duplicated constant (R13-H2)"],
    [mentions("url", "port", "endpoint", "localhost"), "medium", "MEDIUM: hardcoded URL/port (R13-M2)"],
    [mentions("css", "style", "padding", "margin", "gap", "px", "selector"), "low", "LOW: CSS value (R13-L1)"],
    [always, "medium", "MEDIUM: magic number (R13-M1)"],
  ],
  R09: [
    [mentions("secret", "token", "password", "key"), "high", "HIGH: potential secret leak (R09-H1)"],
    [(desc) => desc.includes("commented") && mentions("block", "dead", ">5")(desc), "high", "HIGH: commented-out code block (R09-H2)"],
    [mentions("console.error"), "low", "LOW: console.error in catch (R09-L1)"],
    [mentions("console"), "medium", "MEDIUM: console in production (R09-M1)"],
    [mentions("unicode", "ternary"), "low", "LOW: style preference (R09-L2)"],
    [always, "medium", "MEDIUM: clean code issue (R09-M1)"],
  ],
};

// Gives a finding its confidence, from its rule and description, when its scanner gave none.
function assignConfidenceIfMissing(finding: Row): void {
  if (isPyTruthy(finding["confidence"])) return;
  const rule = finding["rule"] === undefined ? "" : pyStr(finding["rule"]);
  const description = finding["description"];
  const desc = typeof description === "string" ? description.toLowerCase() : "";
  const decision = (Object.hasOwn(CONFIDENCE_DECISIONS, rule) ? CONFIDENCE_DECISIONS[rule] : undefined)?.find(([applies]) => applies(desc));
  finding["confidence"] = decision?.[1] ?? "high";
  finding["confidence_reason"] = decision?.[2] ?? `HIGH: ${rule} violations are precise`;
}

function readEnrichedFindings(enrichedDir: string): Row[] {
  if (!existsSync(enrichedDir)) return [];
  const findings: Row[] = [];
  const names = readdirSync(enrichedDir)
    .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
    .sort();
  for (const name of names) {
    for (const line of universalLines(readTextStrict(join(enrichedDir, name)))) {
      const stripped = pyStrip(line);
      if (stripped === "") continue;
      const parsed: unknown = JSON.parse(stripped);
      if (!isRecord(parsed)) throw new TypeError(`${name}: every row must be a JSON object`);
      findings.push(parsed);
    }
  }
  return findings;
}

export function mergeEnriched(auditDir: string): MergeResult {
  const dataDir = join(auditDir, "data");
  const original = join(dataDir, "findings.jsonl");
  const previousCount = universalLines(readTextStrict(original)).length;
  const findings = readEnrichedFindings(join(dataDir, "enriched"));
  if (findings.length < previousCount) throw new EnrichmentLossError(findings.length, previousCount);
  for (const finding of findings) assignConfidenceIfMissing(finding);

  const candidate = `${original}.tmp`;
  try {
    writeFileSync(candidate, findings.map((finding) => pyJsonDumps(finding) + "\n").join(""));
    const normalized = normalizeFindingsFile(candidate);
    const groups = applyCrossCutting(candidate, CROSS_CUTTING_MIN_FILES);
    renameSync(candidate, original);
    return { count: findings.length, previousCount, normalized, groups };
  } finally {
    rmSync(candidate, { force: true });
  }
}

if (import.meta.main) {
  const auditDir = process.argv[2];
  if (auditDir === undefined) {
    console.error("Usage: merge-enriched.ts <audit_dir>");
    process.exit(1);
  }
  try {
    const result = mergeEnriched(auditDir);
    console.log(`Merged: ${result.count} findings (was ${result.previousCount})`);
    console.log(`Normalized: ${result.normalized} findings to canonical categories`);
    console.log(`Cross-cutting: ${result.groups} groups detected`);
  } catch (error) {
    if (!(error instanceof EnrichmentLossError)) throw error;
    console.log(`Merged: ${error.count} findings (was ${error.previousCount})`);
    console.log(`WARNING: Lost ${error.previousCount - error.count} findings! The original findings.jsonl is unchanged.`);
    process.exit(1);
  }
}
