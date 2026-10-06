// Deterministic .env safety checks: committed secrets, a missing .env.example, drift between
// the variables the code reads and .env.example, and duplicate keys.
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { readTextOrNull, walkProjectFiles } from "@quality/files.ts";
import { readTextStrict } from "@quality/io.ts";
import { runCommand } from "@quality/process.ts";
import type { Finding } from "@quality/types.ts";

const GIT_TIMEOUT_MS = 10_000;
const ENV_FILES: readonly string[] = [".env", ".env.local", ".env.production"];
const SNIPPET_MAX_CHARS = 200;
const DEFAULT_PHASE = 5;
const PHASE_BY_RULE: Readonly<Record<string, number>> = { R05: 1, R09: 5, R12: 7 };
const SCANNER = "env-check";
const GITIGNORE_ENV_PATTERNS: readonly string[] = [".env", ".env*", ".env.*"];
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build",
  ".next", ".turbo", "coverage", ".cache", ".nyc_output", "target", ".gradle",
]);
const ENV_NAME = "[A-Za-z_][A-Za-z0-9_]*";
const ENV_READ_PATTERNS: readonly RegExp[] = [
  new RegExp(`process\\.env\\.(${ENV_NAME})`, "g"),
  new RegExp(`os\\.environ\\["(${ENV_NAME})"\\]`, "g"),
  new RegExp(`os\\.environ\\['(${ENV_NAME})'\\]`, "g"),
  new RegExp(`os\\.getenv\\("(${ENV_NAME})"`, "g"),
  new RegExp(`os\\.getenv\\('(${ENV_NAME})'`, "g"),
  new RegExp(`os\\.environ\\.get\\("(${ENV_NAME})"`, "g"),
  new RegExp(`os\\.environ\\.get\\('(${ENV_NAME})'`, "g"),
];

type EnvFindingFields = {
  rule: string;
  severity: string;
  category: string;
  file: string;
  line: number;
  description: string;
  confidence: string;
  confidence_reason: string;
};

function makeEnvFinding(fields: EnvFindingFields): Finding {
  const excerpt = fields.description.slice(0, SNIPPET_MAX_CHARS);
  return {
    rule: fields.rule,
    severity: fields.severity,
    category: fields.category,
    file: fields.file,
    line: fields.line,
    end_line: fields.line,
    snippet: excerpt,
    current_code: excerpt,
    description: fields.description,
    explanation: fields.description,
    search_pattern: "",
    phase: PHASE_BY_RULE[fields.rule] ?? DEFAULT_PHASE,
    effort: "low",
    scanner: SCANNER,
    confidence: fields.confidence,
    confidence_reason: fields.confidence_reason,
    tool_rule_id: "",
    cwe: [],
  };
}

// An env file tracked by git is a leaked secret (R05). A missing git binary or a directory
// git cannot read means there is nothing to report, not a failure of the audit.
function checkCommittedEnv(projectDir: string): Finding[] {
  const outcome = runCommand(["git", "ls-files", ...ENV_FILES], { cwd: projectDir, timeoutMs: GIT_TIMEOUT_MS });
  if (outcome.status !== "exited") return [];
  return outcome.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((tracked) => tracked !== "")
    .map((tracked) =>
      makeEnvFinding({
        rule: "R05",
        severity: "CRITICAL",
        category: "security",
        file: tracked,
        line: 1,
        description: `Environment file '${tracked}' is committed to git. This may expose secrets. Add it to .gitignore and remove from tracking.`,
        confidence: "high",
        confidence_reason: `Deterministic: git ls-files shows '${tracked}' is tracked`,
      }),
    );
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

// Python reads text files with universal newlines: \r\n and a lone \r both end a line.
const textLines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

// MEDIUM R12: .env is gitignored but nothing tells a developer which variables to set.
function checkEnvExampleExists(projectDir: string): Finding[] {
  const gitignorePath = join(projectDir, ".gitignore");
  if (!isFile(gitignorePath)) return [];
  const envIgnored = textLines(readTextStrict(gitignorePath))
    .map((line) => line.trim())
    .some((line) => line !== "" && !line.startsWith("#") && GITIGNORE_ENV_PATTERNS.includes(line));
  if (!envIgnored || isFile(join(projectDir, ".env.example"))) return [];
  return [
    makeEnvFinding({
      rule: "R12",
      severity: "MEDIUM",
      category: "data-integrity",
      file: ".gitignore",
      line: 1,
      description: ".env is gitignored but no .env.example file exists. Create .env.example with placeholder values so developers know which environment variables are required.",
      confidence: "high",
      confidence_reason: "Deterministic: .env in .gitignore but .env.example missing",
    }),
  ];
}

function parseEnvKeys(path: string): Set<string> {
  const keys = new Set<string>();
  for (const line of textLines(readTextStrict(path))) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const key = (stripped.split("=", 1)[0] ?? "").trim();
    if (key !== "") keys.add(key);
  }
  return keys;
}

function scanSourceForEnvVars(projectDir: string): Set<string> {
  const names = new Set<string>();
  for (const rel of walkProjectFiles(projectDir, SKIP_DIRS)) {
    if (!SOURCE_EXTENSIONS.has(extname(rel))) continue;
    const content = readTextOrNull(join(projectDir, rel));
    if (content === null) continue;
    for (const pattern of ENV_READ_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

// LOW R12: a variable the code reads that .env.example does not list.
function checkEnvVarConsistency(projectDir: string): Finding[] {
  const examplePath = join(projectDir, ".env.example");
  if (!isFile(examplePath)) return [];
  const exampleKeys = parseEnvKeys(examplePath);
  const missing = [...scanSourceForEnvVars(projectDir)].filter((name) => !exampleKeys.has(name)).sort();
  return missing.map((name) =>
    makeEnvFinding({
      rule: "R12",
      severity: "LOW",
      category: "data-integrity",
      file: ".env.example",
      line: 1,
      description: `Environment variable '${name}' is referenced in code but missing from .env.example.`,
      confidence: "medium",
      confidence_reason: `Deterministic: '${name}' found in source but not in .env.example`,
    }),
  );
}

// LOW R09: the same key defined twice in .env.example.
function checkDuplicateKeys(projectDir: string): Finding[] {
  const examplePath = join(projectDir, ".env.example");
  if (!isFile(examplePath)) return [];
  const seen = new Map<string, number>();
  const findings: Finding[] = [];
  textLines(readTextStrict(examplePath)).forEach((line, index) => {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#") || !stripped.includes("=")) return;
    const key = (stripped.split("=", 1)[0] ?? "").trim();
    const lineNumber = index + 1;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, lineNumber);
      return;
    }
    findings.push(
      makeEnvFinding({
        rule: "R09",
        severity: "LOW",
        category: "clean-code",
        file: ".env.example",
        line: lineNumber,
        description: `Duplicate key '${key}' in .env.example (first defined on line ${first}).`,
        confidence: "high",
        confidence_reason: `Deterministic: key '${key}' appears on lines ${first} and ${lineNumber}`,
      }),
    );
  });
  return findings;
}

export function checkEnv(projectDir: string): Finding[] {
  return [
    ...checkCommittedEnv(projectDir),
    ...checkEnvExampleExists(projectDir),
    ...checkEnvVarConsistency(projectDir),
    ...checkDuplicateKeys(projectDir),
  ];
}
