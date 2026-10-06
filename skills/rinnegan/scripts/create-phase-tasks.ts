// Deterministically generate the phase task files from the published findings.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { isPyTruthy, pyStrip, universalLines } from "@quality/py-text.ts";
import { isPhaseNumber, MAX_PHASE, SPEC_PHASE_EDGES, SPEC_PHASE_NODES } from "@rinnegan/phase-contract.ts";
import type { PhaseNode } from "@rinnegan/phase-contract.ts";

type Json = Record<string, unknown>;
type Verification = { command: string; expected: string; description: string };

const MANUAL_REVIEW = "echo MANUAL_REVIEW_REQUIRED";
const MANUAL_EXPECTED = "MANUAL_REVIEW_REQUIRED";
const PASS = "PASS";
const ENV_SILENCE = ">/dev/null 2>&1";

const BUILD_COMMANDS: Readonly<Record<string, string>> = {
  typescript: `bunx tsc --noEmit ${ENV_SILENCE} && echo PASS`,
  python: `uv run python -m compileall -q . ${ENV_SILENCE} && echo PASS`,
  java: `mvn -q -DskipTests compile ${ENV_SILENCE} && echo PASS`,
};

const TEST_AND_BUILD_COMMANDS: Readonly<Record<string, string>> = {
  typescript: `bun run test ${ENV_SILENCE} && bunx tsc --noEmit ${ENV_SILENCE} && echo PASS`,
  python: `uv run pytest -q ${ENV_SILENCE} && uv run python -m compileall -q . ${ENV_SILENCE} && echo PASS`,
  java: `mvn -q test ${ENV_SILENCE} && echo PASS`,
};

const TYPE_COMMANDS: Readonly<Record<string, string>> = {
  typescript: "grep -RInE '\\bany\\b' . --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' | wc -l | tr -d ' '",
  python: "grep -RInE '\\bAny\\b|type:\\s*ignore|typing\\.Any' . --include='*.py' | wc -l | tr -d ' '",
  java: "grep -RInE '@SuppressWarnings\\(\"unchecked\"\\)|\\(.*\\)' . --include='*.java' --include='*.kt' | wc -l | tr -d ' '",
};

const SECURITY_COMMAND = "grep -RInE 'verify=False|shell=True|exec\\(|eval\\(|subprocess\\..*shell=True' . | wc -l | tr -d ' '";
const HYGIENE_COMMAND =
  "grep -RInE 'console\\.log|TODO|FIXME' . --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.java' --include='*.kt' | wc -l | tr -d ' '";
const PYTHON_TEST_MARKERS: readonly string[] = ["tests", "test", "pytest.ini", "pyproject.toml"];

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

function loadJsonl(path: string): Json[] {
  const rows: Json[] = [];
  for (const line of universalLines(readTextStrict(path))) {
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const row: unknown = JSON.parse(stripped);
    if (!isRecord(row)) throw new TypeError(`${path}: a row is not a JSON object`);
    rows.push(row);
  }
  return rows;
}

const plainText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);

function phasePrerequisites(): Map<number, string[]> {
  const prerequisites = new Map<number, string[]>(SPEC_PHASE_NODES.map((node) => [node.id, []]));
  for (const edge of SPEC_PHASE_EDGES) prerequisites.get(edge.to)?.push(`phase-${edge.from}`);
  return prerequisites;
}

function phaseByRule(): Map<string, number> {
  const mapping = new Map<string, number>();
  for (const node of SPEC_PHASE_NODES) for (const rule of node.rules) mapping.set(rule, node.id);
  return mapping;
}

function normalizeImports(targetImport: unknown): string[] {
  if (Array.isArray(targetImport)) return (targetImport as unknown[]).map(plainText).filter((item) => pyStrip(item) !== "");
  if (typeof targetImport === "string" && pyStrip(targetImport) !== "") return [pyStrip(targetImport)];
  return [];
}

// A finding's own phase when it is a valid one, else the phase that owns its rule, else the last.
function determinePhase(finding: Json, byRule: ReadonlyMap<string, number>): number {
  const phase = finding["phase"];
  if (isPhaseNumber(phase)) return phase;
  return byRule.get(pyStrip(plainText(finding["rule"]))) ?? MAX_PHASE;
}

// int(finding.get("line", 0) or 0)
function lineOf(finding: Json): number {
  const line = finding["line"];
  if (!isPyTruthy(line)) return 0;
  if (typeof line === "number") return Math.trunc(line);
  if (typeof line === "string" && /^\s*[+-]?\d+\s*$/.test(line)) return Number(line);
  throw new TypeError(`finding ${plainText(finding["id"])}: line is not an integer`);
}

// finding.get(key, fallback): an explicit null stays null, only an absent key takes the fallback.
const get = (row: Json, key: string, fallback: unknown): unknown => (Object.hasOwn(row, key) ? row[key] : fallback);

// The task Rasengan receives: exactly the declared fields, never the finding's other keys.
function transformTask(finding: Json): Json {
  const confidence = isPyTruthy(finding["confidence"]) ? plainText(finding["confidence"]) : "high";
  return {
    id: get(finding, "id", ""),
    status: "pending",
    rule: get(finding, "rule", ""),
    severity: get(finding, "severity", ""),
    group: get(finding, "group", ""),
    file: get(finding, "file", ""),
    line: get(finding, "line", 0),
    current_code: get(finding, "current_code", null),
    target_code: get(finding, "target_code", null),
    imports_needed: normalizeImports(finding["target_import"]),
    search_pattern: get(finding, "search_pattern", ""),
    explanation: get(finding, "explanation", ""),
    effort: get(finding, "effort", ""),
    fix_plan: get(finding, "fix_plan", null),
    confidence: confidence.toLowerCase(),
    confidence_reason: get(finding, "confidence_reason", ""),
    completed_at: null,
    resolution: null,
    actual_line: null,
    notes: "",
  };
}

function stackHasTests(projectDir: string, stack: string): boolean {
  if (stack === "typescript") {
    const packageJson = join(projectDir, "package.json");
    if (!isFile(packageJson)) return false;
    let manifest: unknown;
    try {
      manifest = JSON.parse(readTextStrict(packageJson));
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
    return isRecord(scripts) && pyStrip(plainText(scripts["test"])) !== "";
  }
  if (stack === "python") return PYTHON_TEST_MARKERS.some((marker) => existsSync(join(projectDir, marker)));
  if (stack === "java") return existsSync(join(projectDir, "pom.xml")) || existsSync(join(projectDir, "build.gradle"));
  return false;
}

const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

function manualOr(command: string | undefined, description: string): Verification {
  if (command === undefined) return { command: MANUAL_REVIEW, expected: MANUAL_EXPECTED, description };
  return { command, expected: "0", description };
}

function verificationForPhase(phaseId: number, stack: string, projectDir: string): Verification {
  if (phaseId === 0) {
    const command = own(BUILD_COMMANDS, stack);
    return command === undefined
      ? { command: MANUAL_REVIEW, expected: MANUAL_EXPECTED, description: "Project builds cleanly before remediation begins." }
      : { command, expected: PASS, description: "Project builds cleanly before remediation begins." };
  }
  if (phaseId === 1) return { command: SECURITY_COMMAND, expected: "0", description: "No obvious high-risk security shortcuts remain." };
  if (phaseId === 2) return manualOr(own(TYPE_COMMANDS, stack), "Phase-specific typing shortcuts are removed.");
  if (phaseId === 5) return { command: HYGIENE_COMMAND, expected: "0", description: "No obvious hygiene placeholders remain in source files." };
  if (phaseId === 9) {
    const build = own(BUILD_COMMANDS, stack);
    const withTests = own(TEST_AND_BUILD_COMMANDS, stack);
    if (build !== undefined && withTests !== undefined) {
      return stackHasTests(projectDir, stack)
        ? { command: withTests, expected: PASS, description: "Build and test verification pass for this stack." }
        : { command: build, expected: PASS, description: "Build verification passes; no stack-level test command was detected." };
    }
  }
  return { command: MANUAL_REVIEW, expected: MANUAL_EXPECTED, description: "Manual verification required for this architectural phase." };
}

const phaseTitle = (node: PhaseNode): string => `${node.name} (${node.rules.join(", ")})`;

// Write one phase-<n>-tasks.json per phase and return their paths in phase order.
export function generatePhaseTasks(auditDir: string, projectDir: string): string[] {
  const findings = loadJsonl(join(auditDir, "data", "findings.jsonl"));
  const inventory: unknown = JSON.parse(readTextStrict(join(auditDir, "data", "inventory.json")));
  if (!isRecord(inventory)) throw new TypeError("inventory.json: expected a JSON object");
  const stack = plainText(inventory["stack"] ?? "unknown");
  const byRule = phaseByRule();
  const prerequisites = phasePrerequisites();

  const phased = findings.map((finding) => ({ finding, phase: determinePhase(finding, byRule) }));
  phased.sort(
    (a, b) =>
      a.phase - b.phase ||
      compareText(plainText(a.finding["file"]), plainText(b.finding["file"])) ||
      lineOf(a.finding) - lineOf(b.finding) ||
      compareText(plainText(a.finding["id"]), plainText(b.finding["id"])),
  );

  const tasksDir = join(auditDir, "data", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  return SPEC_PHASE_NODES.map((node) => {
    const tasks = phased.filter((entry) => entry.phase === node.id).map((entry) => transformTask(entry.finding));
    const payload = {
      phase: node.id,
      phase_name: phaseTitle(node),
      prerequisites: prerequisites.get(node.id) ?? [],
      status: tasks.length === 0 ? "clear" : "not_started",
      total_tasks: tasks.length,
      completed: 0,
      tasks,
      verification: verificationForPhase(node.id, stack, projectDir),
    };
    const path = join(tasksDir, `phase-${node.id}-tasks.json`);
    writeFileSync(path, dumpJson(payload) + "\n");
    return path;
  });
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const USAGE_EXIT_CODE = 1;

if (import.meta.main) {
  const [, , auditArg, projectArg] = process.argv;
  if (auditArg === undefined) {
    console.log("Usage: create-phase-tasks.ts <audit_dir> [project_dir]");
    process.exit(USAGE_EXIT_CODE);
  }
  const auditDir = resolve(auditArg);
  const projectDir = projectArg === undefined ? dirname(dirname(auditDir)) : resolve(projectArg);
  console.log(`Generated ${generatePhaseTasks(auditDir, projectDir).length} phase task files`);
}
