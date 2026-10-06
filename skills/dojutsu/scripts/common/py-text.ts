// Python-compatible text and truthiness rules for the retired scripts' JSON artifacts.
import { renameSync, writeFileSync } from "node:fs";
import { isRecord } from "@quality/io.ts";

// str.strip() removes Python's whitespace set, which differs from JS trim() on \x1c-\x1f,
// \x85 and the byte-order mark.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

export const pyStrip = (text: string): string => text.replace(STRIP_RE, "");

// bool(value) for a JSON value: empty strings, containers and zero are false.
export function isPyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return isRecord(value) ? Object.keys(value).length > 0 : true;
}

// The lines `for line in open(path)` yields: universal newlines, terminators removed.
export function universalLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Write beside the target, then rename over it (os.replace): a reader never sees half a file.
export function writeTextAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}
