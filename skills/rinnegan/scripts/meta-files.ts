// Meta-file allowlist: files that define the rule patterns themselves are exempt from the
// rules they spell out. A file qualifies only when directory, filename and content agree.
import { join } from "node:path";
import { readHeadLines } from "@quality/io.ts";

const DIRECTORY_PATTERNS: readonly RegExp[] = [/^scripts\/ci\//, /^scripts\/ce\//, /^scripts\/audit\//, /^scripts\/lint\//, /^scripts\/policy\//];

const NAME_PATTERNS: readonly RegExp[] = [/\/enforce-[^/]+\.(ts|js|py|mjs)$/, /\/verify-[^/]+\.(ts|js|py|mjs)$/, /-rule-[^/]+\.(ts|js|py|mjs)$/];

const CONTENT_MARKERS: readonly string[] = ["RULE_PATTERNS", "PatternDef", "RULE_DEFS"];

const CONTENT_HEAD_LINES = 100;

// True only if the directory, the filename and a marker in the first 100 lines all match;
// a production file under scripts/ci/ without a marker is not allowlisted.
export function isMetaFile(relPath: string, projectDir: string): boolean {
  if (!DIRECTORY_PATTERNS.some((pattern) => pattern.test(relPath))) return false;
  if (!NAME_PATTERNS.some((pattern) => pattern.test(relPath))) return false;
  let head: string;
  try {
    head = readHeadLines(join(projectDir, relPath), CONTENT_HEAD_LINES, true);
  } catch {
    return false;
  }
  return CONTENT_MARKERS.some((marker) => head.includes(marker));
}
