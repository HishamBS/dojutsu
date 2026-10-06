// Python-compatible text forms for the artifacts the retired scripts wrote: UTC isoformat
// timestamps, json.dumps' default separators with ASCII escaping, and round()'s tie rule.
import { isRecord } from "@quality/io.ts";

const MS_PER_SECOND = 1000;
const MICROS_PER_MS = 1000;
const MICROS_PER_SECOND = 1_000_000;
const MICRO_DIGITS = 6;
const HEX_RADIX = 16;
const HEX_DIGITS = 4;
const NON_ASCII = /[^\n -~]/g;

// datetime.fromtimestamp(seconds, tz=utc).isoformat(): microseconds appear only when non-zero.
export function isoFromEpochMs(epochMs: number): string {
  const micros = Math.round(epochMs * MICROS_PER_MS);
  const wholeSeconds = Math.floor(micros / MICROS_PER_SECOND);
  const fraction = micros - wholeSeconds * MICROS_PER_SECOND;
  const stamp = new Date(wholeSeconds * MS_PER_SECOND).toISOString().slice(0, "YYYY-MM-DDTHH:MM:SS".length);
  const suffix = fraction === 0 ? "" : `.${String(fraction).padStart(MICRO_DIGITS, "0")}`;
  return `${stamp}${suffix}+00:00`;
}

// datetime.now(timezone.utc).isoformat()
export function nowIso(): string {
  return isoFromEpochMs((performance.timeOrigin + performance.now()));
}

function escapeNonAscii(text: string): string {
  return text.replace(NON_ASCII, (char) => "\\u" + char.charCodeAt(0).toString(HEX_RADIX).padStart(HEX_DIGITS, "0"));
}

// json.dumps(value) with its default ", " and ": " separators and ensure_ascii.
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return escapeNonAscii(JSON.stringify(value));
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(pyJsonDumps).join(", ")}]`;
  if (isRecord(value)) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => `${escapeNonAscii(JSON.stringify(key))}: ${pyJsonDumps(member)}`);
    return `{${members.join(", ")}}`;
  }
  throw new TypeError(`value of type ${typeof value} is not JSON serializable`);
}

// str(): None prints as "None", a missing key as the empty default.
export function pyStr(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

// round(value, 1): an exactly representable tie (a quarter step) goes to the even tenth.
export function roundToTenth(value: number): number {
  const scaled = value * 10;
  const quarterSteps = value * 4;
  const isExactTie = Number.isInteger(quarterSteps) && quarterSteps % 2 !== 0;
  if (!isExactTie) return Number(value.toFixed(1));
  const lower = Math.floor(scaled);
  return (lower % 2 === 0 ? lower : lower + 1) / 10;
}
