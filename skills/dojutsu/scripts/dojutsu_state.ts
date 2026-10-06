// Dojutsu pipeline state management: HMAC-signed state, progress narrative, sentinel file, git
// checkpoints. Designed for session resilience - all state on disk, agent-agnostic.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpJson, homeDir, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps } from "@quality/py-format.ts";

export const STATE_FILE = "docs/audit/data/dojutsu-state.json";
export const HMAC_KEY_FILE = "docs/audit/data/.dojutsu-hmac-key";
export const PROGRESS_FILE = "docs/audit/data/dojutsu-progress.jsonl";
export const DISPATCH_LOG = "docs/audit/data/dispatch-log.jsonl";
export const SENTINEL_FILE = "docs/audit/data/.dojutsu-active";

const HMAC_KEY_BYTES = 32;
const KEY_FILE_MODE = 0o600;
const ASCII_WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
const DEFAULT_MODEL_ENV = "CLAUDE_MODEL";
const UNKNOWN_AGENT = "unknown";

export class IllegalTransitionError extends Error {}

export type DojutsuFlags = {
  mode: string;
  phases: number[] | null;
  approval: string;
  resume?: boolean;
  status?: boolean;
  report?: boolean;
  clean?: boolean;
};

export type HistoryEntry = { from: string; to: string; timestamp: string; reason: string };

export type DojutsuState = {
  pipeline_id: string;
  started_at: string;
  last_updated: string;
  stage: string;
  current_eye: string | null;
  current_phase: number | null;
  verified_phases: number[];
  flags: DojutsuFlags;
  failure_counts: Record<string, number>;
  session_count: number;
  last_agent: string;
  git_checkpoints: Record<string, string>;
  history: HistoryEntry[];
  hmac: string;
  stage_entered_at?: string;
};

function trimAscii(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;
  while (start < end && ASCII_WHITESPACE.has(bytes[start] ?? 0)) start += 1;
  while (end > start && ASCII_WHITESPACE.has(bytes[end - 1] ?? 0)) end -= 1;
  return bytes.subarray(start, end);
}

// The project's signing key, created on first use. It lives under the project, never the cwd.
function hmacKey(projectDir: string): Uint8Array {
  const keyPath = join(projectDir, HMAC_KEY_FILE);
  if (existsSync(keyPath)) return trimAscii(readFileSync(keyPath));
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = Buffer.from(randomBytes(HMAC_KEY_BYTES).toString("hex"));
  writeFileSync(keyPath, key);
  chmodSync(keyPath, KEY_FILE_MODE);
  return key;
}

// HMAC-SHA256 over "<stage>|<last_updated>", keyed by the key file's ASCII bytes.
function computeHmac(projectDir: string, state: Pick<DojutsuState, "stage" | "last_updated">): string {
  return createHmac("sha256", hmacKey(projectDir)).update(`${state.stage}|${state.last_updated}`).digest("hex");
}

function verifyHmac(projectDir: string, state: DojutsuState): boolean {
  const expected = Buffer.from(state.hmac);
  const computed = Buffer.from(computeHmac(projectDir, state));
  return expected.length === computed.length && timingSafeEqual(expected, computed);
}

export function defaultState(): DojutsuState {
  const now = nowIso();
  return {
    pipeline_id: randomUUID(),
    started_at: now,
    last_updated: now,
    stage: "INACTIVE",
    current_eye: null,
    current_phase: null,
    verified_phases: [],
    flags: { mode: "audit", phases: null, approval: "interactive" },
    failure_counts: { rinnegan: 0, byakugan: 0, rasengan: 0, sharingan: 0 },
    session_count: 1,
    last_agent: process.env[DEFAULT_MODEL_ENV] ?? UNKNOWN_AGENT,
    git_checkpoints: {},
    history: [],
    hmac: "",
  };
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new TypeError(`${STATE_FILE}: ${key} must be a string`);
  return value;
}

// The persisted state, narrowed from JSON. A field the Python-era writer always wrote must be there.
function parseState(raw: unknown): DojutsuState {
  if (!isRecord(raw)) throw new TypeError(`${STATE_FILE}: expected an object`);
  const container = (key: string): Record<string, unknown> => {
    const value = raw[key];
    if (!isRecord(value)) throw new TypeError(`${STATE_FILE}: ${key} must be an object`);
    return value;
  };
  const list = (key: string): unknown[] => {
    const value = raw[key];
    if (!Array.isArray(value)) throw new TypeError(`${STATE_FILE}: ${key} must be a list`);
    return value as unknown[];
  };
  const optionalString = (key: string): string | null => (raw[key] === null ? null : requireString(raw, key));
  const sessionCount = raw["session_count"];
  const currentPhase = raw["current_phase"];
  if (typeof sessionCount !== "number") throw new TypeError(`${STATE_FILE}: session_count must be a number`);
  if (currentPhase !== null && typeof currentPhase !== "number") throw new TypeError(`${STATE_FILE}: current_phase must be a number or null`);
  return {
    ...raw,
    pipeline_id: requireString(raw, "pipeline_id"),
    started_at: requireString(raw, "started_at"),
    last_updated: requireString(raw, "last_updated"),
    stage: requireString(raw, "stage"),
    current_eye: optionalString("current_eye"),
    current_phase: currentPhase,
    verified_phases: list("verified_phases") as number[],
    flags: container("flags") as DojutsuFlags,
    failure_counts: container("failure_counts") as Record<string, number>,
    session_count: sessionCount,
    last_agent: requireString(raw, "last_agent"),
    git_checkpoints: container("git_checkpoints") as Record<string, string>,
    history: list("history") as HistoryEntry[],
    hmac: typeof raw["hmac"] === "string" ? raw["hmac"] : "",
  };
}

// Loads and HMAC-verifies the state on disk; a fresh unsigned state when there is no file.
export function loadState(projectDir: string): DojutsuState {
  const path = join(projectDir, STATE_FILE);
  if (!existsSync(path)) return defaultState();
  const state = parseState(JSON.parse(readTextStrict(path)));
  if (!verifyHmac(projectDir, state)) {
    throw new Error("HMAC mismatch on dojutsu-state.json — state file may be tampered. Delete the file to restart the pipeline, or investigate.");
  }
  return state;
}

export function saveState(projectDir: string, state: DojutsuState): void {
  state.last_updated = nowIso();
  state.hmac = computeHmac(projectDir, state);
  const path = join(projectDir, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, dumpJson(state));
}

const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  INACTIVE: ["RINNEGAN_ACTIVE"],
  RINNEGAN_ACTIVE: ["BYAKUGAN_ACTIVE"],
  BYAKUGAN_ACTIVE: ["RASENGAN_PHASE_0", "AUDIT_COMPLETE"],
};
const RASENGAN_PREFIX = "RASENGAN_PHASE_";
const SHARINGAN_PREFIX = "SHARINGAN_PHASE_";
const PIPELINE_COMPLETE = "PIPELINE_COMPLETE";
const AUDIT_COMPLETE = "AUDIT_COMPLETE";

const phaseOf = (stage: string): string => stage.slice(stage.lastIndexOf("_") + 1);

// Whether the pipeline may move from one stage to another. The phase stages are dynamic.
function isLegalTransition(from: string, to: string): boolean {
  if (from === "INACTIVE") return true;
  if (LEGAL_TRANSITIONS[from]?.includes(to)) return true;
  if (from.startsWith(RASENGAN_PREFIX)) {
    if (to.startsWith(RASENGAN_PREFIX) || to === PIPELINE_COMPLETE) return true;
    if (to.startsWith(SHARINGAN_PREFIX)) return phaseOf(from) === phaseOf(to);
  }
  if (from.startsWith(SHARINGAN_PREFIX) && (to.startsWith(RASENGAN_PREFIX) || to === PIPELINE_COMPLETE)) return true;
  if (from === "BYAKUGAN_ACTIVE" && to.startsWith(RASENGAN_PREFIX)) return true;
  if (from === AUDIT_COMPLETE && (to.startsWith(RASENGAN_PREFIX) || to === AUDIT_COMPLETE)) return true;
  // A --phases run completes only the phases it selected; a later run can open the rest.
  return from === PIPELINE_COMPLETE && to.startsWith(RASENGAN_PREFIX);
}

// Tags the current HEAD for rollback; a repository with no commit simply has nothing to tag.
export function tagGitCheckpoint(projectDir: string, label: string): void {
  Bun.spawnSync(["git", "tag", "-f", `dojutsu/${label}`, "HEAD"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
}

export function getHeadSha(projectDir: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

// Moves to a new stage: validates, updates the state, tags git. The state is saved signed.
export function transition(state: DojutsuState, newStage: string, projectDir: string, reason = ""): void {
  const oldStage = state.stage;
  if (!isLegalTransition(oldStage, newStage)) {
    throw new IllegalTransitionError(`Illegal transition: ${oldStage} → ${newStage}. Check pipeline state.`);
  }
  state.history.push({ from: oldStage, to: newStage, timestamp: nowIso(), reason: reason || `auto: ${oldStage} → ${newStage}` });
  state.stage = newStage;

  if (newStage.startsWith("RINNEGAN")) {
    state.current_eye = "rinnegan";
    state.current_phase = null;
  } else if (newStage.startsWith("BYAKUGAN")) {
    state.current_eye = "byakugan";
    state.current_phase = null;
  } else if (newStage.startsWith(RASENGAN_PREFIX)) {
    state.current_eye = "rasengan";
    state.current_phase = Number(phaseOf(newStage));
  } else if (newStage.startsWith(SHARINGAN_PREFIX)) {
    state.current_eye = "sharingan";
    state.current_phase = Number(phaseOf(newStage));
  } else if (newStage === PIPELINE_COMPLETE) {
    state.current_eye = null;
    state.current_phase = null;
  }

  state.stage_entered_at = nowIso();
  saveState(projectDir, state);
  tagGitCheckpoint(projectDir, newStage.toLowerCase().replaceAll("_", "-"));
}

// --- Progress narrative ---

export type ProgressEntry = {
  timestamp: string;
  stage: string;
  eye: string;
  summary: string;
  decisions: string[];
  next_priority: string;
  git_checkpoint: string;
  exit_reason: string | null;
};

export type ProgressInput = {
  stage?: string;
  eye?: string;
  summary?: string;
  decisions?: string[];
  nextPriority?: string;
  gitCheckpoint?: string;
  exitReason?: string | null;
};

const DEFAULT_PROGRESS_ENTRIES = 5;

export function appendProgress(projectDir: string, input: ProgressInput): void {
  const path = join(projectDir, PROGRESS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const entry: ProgressEntry = {
    timestamp: nowIso(),
    stage: input.stage ?? "",
    eye: input.eye ?? "",
    summary: input.summary ?? "",
    decisions: input.decisions ?? [],
    next_priority: input.nextPriority ?? "",
    git_checkpoint: input.gitCheckpoint || getHeadSha(projectDir),
    exit_reason: input.exitReason ?? null,
  };
  appendFileSync(path, pyJsonDumps(entry) + "\n");
}

// The last `lastN` progress entries, oldest first.
export function readProgress(projectDir: string, lastN = DEFAULT_PROGRESS_ENTRIES): Record<string, unknown>[] {
  const path = join(projectDir, PROGRESS_FILE);
  if (!existsSync(path)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const raw of readTextStrict(path).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new TypeError(`${PROGRESS_FILE}: an entry is not an object`);
    entries.push(parsed);
  }
  return entries.slice(-lastN);
}

// --- Token budget tracking ---

export const DEFAULT_SESSION_TOKEN_BUDGET = 500_000;
// Below this many remaining tokens not even one cheap dispatch fits.
const MIN_DISPATCH_TOKENS = 30_000;

// The tokens spent by every dispatch this session; a damaged log line counts for nothing.
export function getTokensUsed(projectDir: string): number {
  const path = join(projectDir, DISPATCH_LOG);
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const raw of readTextStrict(path).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(entry)) throw new TypeError(`${DISPATCH_LOG}: an entry is not an object`);
    const tokens = entry["tokens"] ?? 0;
    if (typeof tokens !== "number") throw new TypeError(`${DISPATCH_LOG}: tokens must be a number`);
    total += tokens;
  }
  return total;
}

const grouped = (value: number): string => value.toLocaleString("en-US");

// Whether another dispatch fits the session budget, and the usage line when it does not.
export function checkBudget(projectDir: string, budget = DEFAULT_SESSION_TOKEN_BUDGET): [boolean, string] {
  const used = getTokensUsed(projectDir);
  const remaining = budget - used;
  if (remaining < MIN_DISPATCH_TOKENS) return [false, `${grouped(used)} tokens used of ${grouped(budget)} budget (${grouped(remaining)} remaining)`];
  return [true, ""];
}

export function logDispatch(projectDir: string, task: string, tokens: number, model = ""): void {
  const path = join(projectDir, DISPATCH_LOG);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, pyJsonDumps({ task, tokens, model, timestamp: nowIso() }) + "\n");
}

export function clearDispatchLog(projectDir: string): void {
  rmSync(join(projectDir, DISPATCH_LOG), { force: true });
}

// --- Sentinel file ---

export function ensureSentinel(projectDir: string): void {
  const path = join(projectDir, SENTINEL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(process.pid));
}

// Active while the sentinel exists and its process is alive; a stale sentinel is removed.
export function isActive(projectDir: string): boolean {
  const path = join(projectDir, SENTINEL_FILE);
  if (!existsSync(path)) return false;
  const text = readTextStrict(path).trim();
  if (/^[+-]?\d+$/.test(text)) {
    try {
      process.kill(Number(text), 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
  rmSync(path, { force: true });
  return false;
}

export function clearSentinel(projectDir: string): void {
  rmSync(join(projectDir, SENTINEL_FILE), { force: true });
}

// --- Eye script resolution ---

const AGENT_SKILL_DIRS: readonly (readonly string[])[] = [
  [".coding-agent", "skills"],
  [".claude", "commands"],
  [".codex", "skills"],
  [".config", "opencode", "command"],
  [".gemini", "skills"],
];
const EYE_SCRIPT = join("scripts", "run-pipeline.ts");
const COMPLETE_STATES: readonly string[] = ["COMPLETE", "PIPELINE_COMPLETE"];

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

// Directories to search for sibling skills, in priority order: the directory this skill sits in,
// then the common agent skill locations under $HOME.
function skillSearchPaths(): string[] {
  const paths: string[] = [];
  const parent = dirname(dirname(import.meta.dir));
  if (isDirectory(parent)) paths.push(parent);
  for (const segments of AGENT_SKILL_DIRS) {
    const candidate = join(homeDir(), ...segments);
    if (isDirectory(candidate) && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

export function resolveSkillDir(skill: string): string {
  for (const base of skillSearchPaths()) {
    const skillDir = join(base, skill);
    if (isDirectory(skillDir)) return realpathSync(skillDir);
  }
  throw new Error(`Cannot find skill '${skill}'. Install it beside dojutsu in the same skills directory.`);
}

// A sibling eye's run-pipeline script.
export function resolveEyeScript(eye: string): string {
  const skillDir = resolveSkillDir(eye);
  const script = join(skillDir, EYE_SCRIPT);
  if (existsSync(script)) return script;
  throw new Error(`Cannot find run-pipeline.ts for ${eye} in ${skillDir}/scripts/`);
}

// Whether an eye's pipeline output says it finished.
export function isEyeComplete(stdout: string, eye: string): boolean {
  for (const line of stdout.split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("STATE:")) continue;
    if (COMPLETE_STATES.includes(stripped.slice(stripped.indexOf(":") + 1).trim())) return true;
    if (eye === "rasengan" && stripped.includes("ALL_PHASES_COMPLETE")) return true;
  }
  return false;
}
