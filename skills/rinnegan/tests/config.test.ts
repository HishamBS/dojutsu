import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { DojutsuConfig } from "@rinnegan/dojutsu_config.ts";

const TIER_TOML = (tier: string, window: number, batch: number): string =>
  `[pipeline]\nbatch_size = ${batch}\n\n[models.tiers.${tier}]\ncontext_window = ${window}\n\n[models.assignments]\nscanner = "${tier}"\n`;

const NO_CONFIG = "/nonexistent/path/dojutsu.toml";

function configFrom(toml: string): DojutsuConfig {
  return new DojutsuConfig(join(projectFiles({ "dojutsu.toml": toml }), "dojutsu.toml"));
}

const SAMPLE_TOML = `[pipeline]
batch_size = 25
max_parallel_agents = 5
session_token_budget = 250000

[models.tiers.cheap]
claude = "claude-haiku-4-5"
context_window = 200000

[models.tiers.mid]
claude = "claude-sonnet-4-6"
context_window = 1000000

[models.tiers.premium]
claude = "claude-opus-4-6"
context_window = 1000000

[models.assignments]
scanner = "cheap"
enricher = "mid"
master_hub_generator = "premium"
`;

describe("DojutsuConfig lookups", () => {
  it.each([
    { name: "batch size", read: (c: DojutsuConfig) => c.batchSize, expected: 25 },
    { name: "max parallel", read: (c: DojutsuConfig) => c.maxParallel, expected: 5 },
    { name: "session token budget", read: (c: DojutsuConfig) => c.sessionTokenBudget, expected: 250_000 },
    { name: "assigned tier", read: (c: DojutsuConfig) => c.tierFor("scanner"), expected: "cheap" },
    { name: "premium tier", read: (c: DojutsuConfig) => c.tierFor("master_hub_generator"), expected: "premium" },
    { name: "unknown role tier", read: (c: DojutsuConfig) => c.tierFor("nonexistent_role"), expected: "mid" },
    { name: "claude model", read: (c: DojutsuConfig) => c.modelFor("scanner"), expected: "claude-haiku-4-5" },
    { name: "premium claude model", read: (c: DojutsuConfig) => c.modelFor("master_hub_generator"), expected: "claude-opus-4-6" },
    { name: "engine without a model", read: (c: DojutsuConfig) => c.modelFor("enricher", "codex"), expected: "sonnet" },
    { name: "cheap context window", read: (c: DojutsuConfig) => c.contextWindowFor("scanner"), expected: 200_000 },
    { name: "mid context window", read: (c: DojutsuConfig) => c.contextWindowFor("enricher"), expected: 1_000_000 },
    { name: "unknown role context window", read: (c: DojutsuConfig) => c.contextWindowFor("nonexistent_role"), expected: 1_000_000 },
  ])("$name", ({ read, expected }) => {
    expect(read(configFrom(SAMPLE_TOML))).toBe(expected);
  });
});

describe("DojutsuConfig defaults", () => {
  it.each([
    { name: "batch size", read: (c: DojutsuConfig) => c.batchSize, expected: 30 },
    { name: "max parallel", read: (c: DojutsuConfig) => c.maxParallel, expected: 3 },
    { name: "session token budget", read: (c: DojutsuConfig) => c.sessionTokenBudget, expected: 500_000 },
    { name: "scanner tier", read: (c: DojutsuConfig) => c.tierFor("scanner"), expected: "mid" },
    { name: "scanner model", read: (c: DojutsuConfig) => c.modelFor("scanner"), expected: "sonnet" },
    { name: "premium role model", read: (c: DojutsuConfig) => c.modelFor("narrator"), expected: "opus" },
    { name: "scanner context window", read: (c: DojutsuConfig) => c.contextWindowFor("scanner"), expected: 1_000_000 },
    { name: "unknown role model", read: (c: DojutsuConfig) => c.modelFor("totally_unknown"), expected: "sonnet" },
  ])("$name", ({ read, expected }) => {
    expect(read(new DojutsuConfig(NO_CONFIG))).toBe(expected);
  });
});

function directiveOrThrows(role: string): string {
  try {
    return new DojutsuConfig(NO_CONFIG).enforceModelDirective(role);
  } catch {
    return "throws";
  }
}

describe("DojutsuConfig.enforceModelDirective", () => {
  it.each([
    { role: "scanner", expected: 'model: "sonnet"' },
    { role: "master_hub_generator", expected: 'model: "opus"' },
    { role: "nonexistent_role", expected: "throws" },
  ])("directive for $role", ({ role, expected }) => {
    expect(directiveOrThrows(role)).toBe(expected);
  });
});

describe("DojutsuConfig loading", () => {
  it("rejects a malformed explicit file instead of reading as clean defaults", () => {
    expect(() => configFrom("[pipeline\nbatch_size = ")).toThrow();
  });
});

const HOME_CONFIG_PATH = ".claude/skills/dojutsu/dojutsu.toml";

function discoveredBatchSize(env: { configDir?: string; homeFiles: Record<string, string> }): number {
  const saved = { home: process.env["HOME"], configDir: process.env["DOJUTSU_CONFIG"] };
  process.env["HOME"] = projectFiles(env.homeFiles);
  if (env.configDir === undefined) delete process.env["DOJUTSU_CONFIG"];
  else process.env["DOJUTSU_CONFIG"] = env.configDir;
  try {
    return new DojutsuConfig().batchSize;
  } finally {
    if (saved.home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved.home;
    if (saved.configDir === undefined) delete process.env["DOJUTSU_CONFIG"];
    else process.env["DOJUTSU_CONFIG"] = saved.configDir;
  }
}

describe("DojutsuConfig discovery", () => {
  it.each([
    {
      name: "the DOJUTSU_CONFIG directory wins over the home config",
      envToml: "[pipeline]\nbatch_size = 42\n",
      homeFiles: { [HOME_CONFIG_PATH]: "[pipeline]\nbatch_size = 7\n" },
      expected: 42,
    },
    {
      name: "a missing DOJUTSU_CONFIG directory falls through to the home config",
      envToml: null,
      homeFiles: { [HOME_CONFIG_PATH]: "[pipeline]\nbatch_size = 7\n" },
      expected: 7,
    },
    { name: "no config anywhere gives the defaults", envToml: undefined, homeFiles: { ".keep": "" }, expected: 30 },
  ])("$name", ({ envToml, homeFiles, expected }) => {
    const configDir = envToml === null ? "/nonexistent/dir/xyz" : envToml === undefined ? undefined : projectFiles({ "dojutsu.toml": envToml });
    expect(discoveredBatchSize(configDir === undefined ? { homeFiles } : { configDir, homeFiles })).toBe(expected);
  });
});

describe("DojutsuConfig.maxBatchFor", () => {
  it.each([
    { name: "mid window, large files", toml: TIER_TOML("mid", 1_000_000, 30), loc: 10_000, expected: 11 },
    { name: "cheap window, large files", toml: TIER_TOML("cheap", 200_000, 25), loc: 2_000, expected: 8 },
    { name: "small files hit the batch cap", toml: TIER_TOML("mid", 1_000_000, 25), loc: 200, expected: 25 },
    { name: "huge files floor at five", toml: TIER_TOML("cheap", 200_000, 25), loc: 50_000, expected: 5 },
  ])("$name", ({ toml, loc, expected }) => {
    expect(configFrom(toml).maxBatchFor("scanner", loc)).toBe(expected);
  });

  it("uses the default window and batch size with no config file", () => {
    expect(new DojutsuConfig(NO_CONFIG).maxBatchFor("enricher", 500)).toBe(30);
  });
});
