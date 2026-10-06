// Readiness trend tracking across audit runs: append a readiness entry after each audit and
// report the trend (current against previous) once two data points exist.
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps } from "@quality/py-format.ts";
import { pyRound } from "@quality/py-round.ts";
import { pyStrip, universalLines } from "@quality/py-text.ts";

export type TrendEntry = { timestamp: string; score: number; findings: number; critical: number; coverage: number | null };
export type TrendInfo = { current: number; previous: number; delta: number; direction: "improving" | "declining" | "stable" };

export const HISTORY_FILENAME = "readiness-history.jsonl";

const SCORE_DIGITS = 2;
const MIN_TREND_ENTRIES = 2;

const historyPath = (auditDir: string): string => join(auditDir, "data", HISTORY_FILENAME);

// Append one readiness entry as a self-contained JSON line, creating the file and its
// directory when they do not exist.
export function appendTrend(auditDir: string, score: number, findings: number, critical: number, coverage: number | null = null): void {
  const path = historyPath(auditDir);
  mkdirSync(join(auditDir, "data"), { recursive: true });
  const entry: TrendEntry = {
    timestamp: nowIso(),
    score: pyRound(score, SCORE_DIGITS),
    findings,
    critical,
    coverage: coverage === null ? null : pyRound(coverage, SCORE_DIGITS),
  };
  appendFileSync(path, pyJsonDumps(entry) + "\n");
}

// The scores of the history's valid entries: lines that are not JSON objects with a numeric
// score are corrupted or foreign and are skipped.
function readScores(path: string): number[] {
  const scores: number[] = [];
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(stripped);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (isRecord(entry) && typeof entry["score"] === "number") scores.push(entry["score"]);
  }
  return scores;
}

// The trend between the last two history entries, or null when fewer than two exist.
export function getTrend(auditDir: string): TrendInfo | null {
  const path = historyPath(auditDir);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const scores = readScores(path);
  if (scores.length < MIN_TREND_ENTRIES) return null;
  const current = scores[scores.length - 1] ?? 0;
  const previous = scores[scores.length - 2] ?? 0;
  const delta = pyRound(current - previous, SCORE_DIGITS);
  return { current, previous, delta, direction: delta > 0 ? "improving" : delta < 0 ? "declining" : "stable" };
}
