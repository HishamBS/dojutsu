// Dojutsu SSOT config loader: dojutsu.toml is the single source of truth for the pipeline
// settings, read once per process and addressed by dotted key.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir, isRecord, readTomlFile } from "@quality/io.ts";

const CONFIG_FILE_NAME = "dojutsu.toml";
const DEFAULT_PROGRESS_PREFIX = "[dojutsu]";
const INSTALL_DIRS: readonly (readonly string[])[] = [
  [".coding-agent", "skills", "dojutsu"],
  [".claude", "commands", "dojutsu"],
  [".codex", "skills", "dojutsu"],
];

export class ConfigNotFoundError extends Error {}

let cache: Record<string, unknown> | undefined;

// The skill directory beside scripts/, then the common install locations under $HOME.
function findConfigPath(): string {
  const beside = join(dirname(import.meta.dir), CONFIG_FILE_NAME);
  if (existsSync(beside)) return beside;
  for (const segments of INSTALL_DIRS) {
    const candidate = join(homeDir(), ...segments, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
  }
  throw new ConfigNotFoundError("dojutsu.toml not found. Restore it in the dojutsu skill directory, beside scripts/.");
}

export function loadConfig(): Record<string, unknown> {
  cache ??= readTomlFile(findConfigPath());
  return cache;
}

// A dotted key such as "pipeline.batch_size"; undefined when any segment is missing.
export function get(key: string): unknown {
  let current: unknown = loadConfig();
  for (const part of key.split(".")) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function getProgressPrefix(): string {
  const value = get("pipeline.progress_prefix");
  if (value === undefined) return DEFAULT_PROGRESS_PREFIX;
  if (typeof value !== "string") throw new TypeError("pipeline.progress_prefix: expected a string");
  return value;
}
