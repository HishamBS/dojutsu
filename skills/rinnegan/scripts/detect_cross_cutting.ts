// Deterministic cross-cutting detection: findings grouped by (rule, search_pattern), a group
// spanning enough files being one cross-cutting concern. It replaces an LLM similarity pass
// with a grouping that never fails silently.
import { isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps, pyStr } from "@quality/py-format.ts";
import { isPyTruthy, pyStrip, universalLines, writeTextAtomic } from "@quality/py-text.ts";

type Row = Record<string, unknown>;

const DEFAULT_MIN_FILES = 3;
const DESCRIPTION_KEY_CHARS = 60;

const firstChars = (text: string): string => [...text].slice(0, DESCRIPTION_KEY_CHARS).join("");

// str(finding.get(key, fallback)): a missing key reads as the fallback, an explicit null as "None".
const textOr = (finding: Row, key: string, fallback: string): string => (finding[key] === undefined ? fallback : pyStr(finding[key]));

// Marks every finding of a qualifying group (cross_cutting, cross_cutting_group) in place and
// returns the number of groups.
function markGroups(findings: readonly Row[], minFiles: number): number {
  const groups = new Map<string, Row[]>();
  for (const finding of findings) {
    const pattern = isPyTruthy(finding["search_pattern"]) ? pyStr(finding["search_pattern"]) : firstChars(textOr(finding, "description", ""));
    const key = `${textOr(finding, "rule", "unknown")}|${pattern}`;
    const members = groups.get(key) ?? [];
    members.push(finding);
    groups.set(key, members);
  }

  let groupCount = 0;
  for (const members of groups.values()) {
    const uniqueFiles = new Set(members.map((member) => pyStr(member["file"])));
    if (uniqueFiles.size < minFiles) continue;
    groupCount += 1;
    const groupName = `${textOr(members[0] ?? {}, "rule", "unknown")} across ${uniqueFiles.size} files`;
    for (const member of members) {
      member["cross_cutting"] = true;
      member["cross_cutting_group"] = groupName;
    }
  }
  return groupCount;
}

// Reads a findings.jsonl, marks its cross-cutting groups, writes it back and returns the
// number of groups.
export function applyCrossCutting(findingsPath: string, minFiles = DEFAULT_MIN_FILES): number {
  const findings: Row[] = [];
  for (const line of universalLines(readTextStrict(findingsPath))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) throw new TypeError(`${findingsPath}: every row must be a JSON object`);
    findings.push(parsed);
  }
  const groupCount = markGroups(findings, minFiles);
  writeTextAtomic(findingsPath, findings.map((finding) => pyJsonDumps(finding) + "\n").join(""));
  return groupCount;
}
