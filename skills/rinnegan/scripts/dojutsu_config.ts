// TOML config reader for the dojutsu pipeline: batch sizes, model assignments, context
// windows and token budgets, with built-in defaults when the config file is missing.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeDir, isRecord, readTomlFile } from "@quality/io.ts";

export const PROMPT_OVERHEAD_TOKENS = 30_000;
export const TOKENS_PER_LOC = 5;
export const TOOL_OVERHEAD_PER_FILE = 500;
export const CONTEXT_UTILIZATION = 0.6;

const CONFIG_FILE_NAME = "dojutsu.toml";
const CONFIG_ENV_VAR = "DOJUTSU_CONFIG";
const MIN_BATCH_FILES = 5;
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_SESSION_TOKEN_BUDGET = 500_000;
const DEFAULT_TIER = "mid";
const DEFAULT_MODEL = "sonnet";
const DEFAULT_ENGINE = "claude";
const DEFAULT_AVG_LOC = 500;

const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  cheap: 200_000,
  mid: 1_000_000,
  premium: 1_000_000,
};

const TIER_TO_SHORT_NAME: Readonly<Record<string, string>> = {
  cheap: "haiku",
  mid: "sonnet",
  premium: "opus",
};

const DEFAULT_ASSIGNMENTS: Readonly<Record<string, string>> = {
  scanner: "mid",
  enricher: "mid",
  layer_generator: "mid",
  master_hub_generator: "premium",
  cross_cutting_generator: "mid",
  impact_analyst: "mid",
  narrator: "premium",
  scorecard_generator: "mid",
  deployment_planner: "mid",
  fixer: "mid",
  verifier: "mid",
};

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

// $DOJUTSU_CONFIG/dojutsu.toml first, then ~/.claude/skills/dojutsu/dojutsu.toml.
function findConfig(): string | null {
  const envDir = process.env[CONFIG_ENV_VAR];
  if (envDir) {
    const candidate = join(envDir, CONFIG_FILE_NAME);
    if (isFile(candidate)) return candidate;
  }
  const homeCandidate = join(homeDir(), ".claude", "skills", "dojutsu", CONFIG_FILE_NAME);
  return isFile(homeCandidate) ? homeCandidate : null;
}

// int(value) for a TOML scalar; anything int() rejects fails loudly.
function toInt(value: unknown, key: string): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value.trim());
  throw new TypeError(`${key}: expected an integer, got ${JSON.stringify(value)}`);
}

// str(value) for a TOML scalar.
function scalarText(value: unknown, key: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new TypeError(`${key}: expected a scalar, got ${JSON.stringify(value)}`);
}

function table(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${key}: expected a table`);
  return value;
}

export class DojutsuConfig {
  private readonly data: Record<string, unknown>;

  constructor(configPath?: string) {
    const resolved = configPath || findConfig();
    this.data = resolved && isFile(resolved) ? readTomlFile(resolved) : {};
  }

  private pipelineInt(key: string, fallback: number): number {
    const value = table(this.data, "pipeline")[key];
    return value === undefined ? fallback : toInt(value, key);
  }

  private models(): Record<string, unknown> {
    return table(this.data, "models");
  }

  get batchSize(): number {
    return this.pipelineInt("batch_size", DEFAULT_BATCH_SIZE);
  }

  get maxParallel(): number {
    return this.pipelineInt("max_parallel_agents", DEFAULT_MAX_PARALLEL);
  }

  get sessionTokenBudget(): number {
    return this.pipelineInt("session_token_budget", DEFAULT_SESSION_TOKEN_BUDGET);
  }

  tierFor(role: string): string {
    const tier = table(this.models(), "assignments")[role];
    if (tier !== undefined && tier !== null) return scalarText(tier, "assignments");
    return DEFAULT_ASSIGNMENTS[role] ?? DEFAULT_TIER;
  }

  modelFor(role: string, engine: string = DEFAULT_ENGINE): string {
    const tierName = this.tierFor(role);
    const model = table(table(this.models(), "tiers"), tierName)[engine];
    if (model !== undefined && model !== null) return scalarText(model, engine);
    return engine === DEFAULT_ENGINE ? (TIER_TO_SHORT_NAME[tierName] ?? DEFAULT_MODEL) : DEFAULT_MODEL;
  }

  // The literal Agent-tool directive for the role's tier; an unknown role is a KeyError.
  enforceModelDirective(role: string): string {
    const assigned = table(this.models(), "assignments");
    if (!(role in DEFAULT_ASSIGNMENTS) && !(role in assigned)) throw new Error(`KeyError: ${role}`);
    const tier = this.tierFor(role);
    const shortName = TIER_TO_SHORT_NAME[tier];
    if (shortName === undefined) throw new Error(`KeyError: ${tier}`);
    return `model: "${shortName}"`;
  }

  contextWindowFor(role: string): number {
    const tierName = this.tierFor(role);
    const window = table(table(this.models(), "tiers"), tierName)["context_window"];
    if (window !== undefined && window !== null) return toInt(window, "context_window");
    return DEFAULT_CONTEXT_WINDOWS[tierName] ?? DEFAULT_CONTEXT_WINDOWS[DEFAULT_TIER] ?? 0;
  }

  // max(5, min(usable // tokens_per_file, batch_size)) for the role's context window.
  maxBatchFor(role: string, avgLoc: number = DEFAULT_AVG_LOC): number {
    const usable = Math.trunc(this.contextWindowFor(role) * CONTEXT_UTILIZATION) - PROMPT_OVERHEAD_TOKENS;
    const tokensPerFile = avgLoc * TOKENS_PER_LOC + TOOL_OVERHEAD_PER_FILE;
    const maxFiles = Math.floor(usable / tokensPerFile);
    return Math.max(MIN_BATCH_FILES, Math.min(maxFiles, this.batchSize));
  }
}
