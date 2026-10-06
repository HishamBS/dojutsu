// Shared file and JSON helpers for the quality skills. Each one reproduces the Python
// behavior the retired scripts relied on (strict UTF-8 reads, universal newlines,
// json.dump's ASCII escaping) so persisted artifacts stay byte-compatible.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";

const READ_CHUNK_BYTES = 8192;
const JSON_INDENT = 2;
const NON_ASCII_OR_CONTROL = /[^\n -~]/g;
const HEX_RADIX = 16;
const HEX_DIGITS = 4;

// Path.home() / expanduser("~"): $HOME first, the account database only when it is unset.
export function homeDir(): string {
  return process.env["HOME"] || homedir();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// open(path).read(): invalid UTF-8 fails loudly and a byte-order mark stays in the text.
export function readTextStrict(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

export function readTomlFile(path: string): Record<string, unknown> {
  const parsed: unknown = Bun.TOML.parse(readTextStrict(path));
  if (!isRecord(parsed)) throw new TypeError(`${path}: TOML document is not a table`);
  return parsed;
}

// json.dumps(value, indent=2) with its default ASCII escaping, as json.dump wrote files.
export function dumpJson(value: unknown): string {
  const text = JSON.stringify(value, null, JSON_INDENT);
  return text.replace(NON_ASCII_OR_CONTROL, (char) => "\\u" + char.charCodeAt(0).toString(HEX_RADIX).padStart(HEX_DIGITS, "0"));
}

// The first `maxLines` lines of a text file with universal newlines, decoding only as many
// 8 KiB chunks as it takes (so a decode error past that point is never seen, as in Python).
export function readHeadLines(path: string, maxLines: number, strict: boolean): string {
  const fd = openSync(path, "r");
  try {
    const decoder = new TextDecoder("utf-8", { fatal: strict, ignoreBOM: true });
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let text = "";
    for (;;) {
      const read = readSync(fd, chunk, 0, READ_CHUNK_BYTES, null);
      if (read === 0) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(chunk.subarray(0, read), { stream: true });
      if (text.replace(/\r\n?/g, "\n").split("\n").length > maxLines) break;
    }
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const head = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? head + "\n" : head;
  } finally {
    closeSync(fd);
  }
}
