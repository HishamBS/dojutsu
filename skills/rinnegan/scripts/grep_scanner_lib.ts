// Deterministic grep scanner: runs the per-stack pattern tables over the inventory's source
// files and writes the findings the LLM scanners build on. Shared by the CLI and the tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { pyJsonDumps } from "@quality/py-format.ts";
import { ConfigNotFoundError, get as configGet } from "@dojutsu/dojutsu_config.ts";
import { isMetaFile } from "@rinnegan/meta-files.ts";
import { GO_PATTERNS } from "@rinnegan/patterns/go.ts";
import { JAVA_PATTERNS } from "@rinnegan/patterns/java.ts";
import { PYTHON_PATTERNS } from "@rinnegan/patterns/python.ts";
import { RUST_PATTERNS } from "@rinnegan/patterns/rust.ts";
import { TYPESCRIPT_PATTERNS } from "@rinnegan/patterns/typescript.ts";
import type { PatternDef, ScanResult, ScannerFinding } from "@rinnegan/scanner_types.ts";

export const CATEGORY_PREFIX: Readonly<Record<string, string>> = {
  security: "SEC",
  typing: "TYP",
  "ssot-dry": "DRY",
  architecture: "ARC",
  "clean-code": "CLN",
  performance: "PRF",
  "data-integrity": "DAT",
  refactoring: "REF",
  "full-stack": "STK",
  documentation: "DOC",
  build: "BLD",
};

const GENERIC_PREFIX = "GEN";
const SCANNER_NAME = "grep-scanner";
const SNIPPET_CHARS = 200;
const DEFAULT_CONFIDENCE = "medium";
const FINDING_EFFORT = "low";
const DEFAULT_LAYER = "misc";

// Paths containing these substrings are skipped entirely ("test/" also covers "tests/").
const SKIP_SUBSTRINGS: readonly string[] = ["node_modules", ".next", "__tests__", ".test.", ".spec.", "test/", "test_", "evaluation/"];

// Rules about the code patterns themselves: a rule-definition file is exempt from them.
const META_FILE_SKIP_RULES: readonly string[] = ["R09", "R13", "R14"];

// Rules whose pattern hits are dropped on a comment line.
const COMMENT_FILTER_RULES: readonly string[] = ["R09", "R07"];
const COMMENT_PREFIXES: readonly string[] = ["//", "*", "/*", "#"];

// String and regex literals, as the scanner's skip_string_literals patterns see them.
const LITERAL_RE = /'(?:[^'\\\n]|\\[^\n])*'|"(?:[^"\\\n]|\\[^\n])*"|`(?:[^`\\]|\\[^\n])*`|\/(?:[^/\\\n]|\\[^\n])+\/[gimsuy]*/g;

// An import, require, use or include line.
const IMPORT_LINE_RE = /^\s*(?:import\b|from\b|require\(|use\b|include\b|#include\b)/;

// innerHTML assigned an empty string clears the node and is not an XSS vector.
const INNERHTML_CLEAR_RE = /\.innerHTML\s*=\s*(?:""|''|``)\s*;?\s*$/;

const PATTERNS_BY_STACK: Readonly<Record<string, readonly PatternDef[]>> = {
  typescript: TYPESCRIPT_PATTERNS,
  python: PYTHON_PATTERNS,
  java: JAVA_PATTERNS,
  kotlin: JAVA_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
};

export function getPatternsForStack(stack: string): readonly PatternDef[] {
  return Object.hasOwn(PATTERNS_BY_STACK, stack) ? (PATTERNS_BY_STACK[stack] ?? []) : [];
}

// First `limit` code points, as Python slices a str.
function truncateChars(text: string, limit: number): string {
  return text.length <= limit ? text : [...text].slice(0, limit).join("");
}

// A file's lines as grep sees them: split on newline only; a binary file yields none.
function readGrepLines(path: string): string[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return [];
  }
  if (bytes.includes(0)) return [];
  const lines = bytes.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildFinding(pat: PatternDef, relPath: string, line: number, code: string, fileToLayer: Readonly<Record<string, string>>): ScannerFinding {
  const match = new RegExp(pat.pattern).exec(code);
  const snippet = truncateChars(code, SNIPPET_CHARS);
  return {
    rule: pat.rule,
    severity: pat.severity,
    category: pat.category,
    file: relPath,
    line,
    end_line: line,
    snippet,
    current_code: snippet,
    description: pat.description,
    explanation: pat.explanation,
    search_pattern: match?.[0] ?? pat.pattern,
    target_code: pat.target_code ?? (pat.removable === true ? "" : null),
    target_import: null,
    fix_plan: null,
    phase: pat.phase,
    effort: FINDING_EFFORT,
    layer: fileToLayer[relPath] ?? DEFAULT_LAYER,
    scanner: SCANNER_NAME,
    confidence: pat.confidence ?? DEFAULT_CONFIDENCE,
    confidence_reason: pat.confidence_reason ?? `Deterministic grep match (${pat.rule})`,
  };
}

const isComment = (code: string): boolean => COMMENT_PREFIXES.some((prefix) => code.startsWith(prefix));

const stripStringLiterals = (code: string): string => code.replace(LITERAL_RE, (literal) => " ".repeat(literal.length));

// fnmatch.fnmatch for the tables' globs: `*` crosses directories, `?` is one character.
// SHORTCUT: bracket expressions are not translated; no pattern table uses one.
function globMatches(path: string, glob: string): boolean {
  const source = [...glob].map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`, "s").test(path);
}

// Findings come out pattern by pattern, then in the order the files were given.
export function scanProject(projectDir: string, sourceFiles: readonly string[], stack: string, fileToLayer: Readonly<Record<string, string>>): ScanResult {
  const patterns = getPatternsForStack(stack);
  const compiled = patterns.map((pat) => new RegExp(pat.pattern));
  const perPattern: ScannerFinding[][] = patterns.map(() => []);

  for (const sourceFile of sourceFiles) {
    const absPath = join(projectDir, sourceFile);
    const relPath = relative(projectDir, absPath);
    if (SKIP_SUBSTRINGS.some((skip) => relPath.includes(skip))) continue;
    const lines = readGrepLines(absPath);
    if (lines.length === 0) continue;
    const layer = fileToLayer[relPath] ?? DEFAULT_LAYER;
    let meta: boolean | undefined;
    const isMeta = (): boolean => (meta ??= isMetaFile(relPath, projectDir));

    patterns.forEach((pat, index) => {
      const regex = compiled[index];
      const sink = perPattern[index];
      if (regex === undefined || sink === undefined || pat.dormant === true) return;
      if (pat.file_glob_excludes?.some((glob) => globMatches(relPath, glob)) === true) return;
      if (pat.layer_exclude?.includes(layer) === true) return;
      lines.forEach((raw, lineIndex) => {
        if (!regex.test(raw)) return;
        if (META_FILE_SKIP_RULES.includes(pat.rule) && isMeta()) return;
        const code = raw.trim();
        if (COMMENT_FILTER_RULES.includes(pat.rule) && isComment(code)) return;
        if (pat.skip_import_lines === true && IMPORT_LINE_RE.test(code)) return;
        if (pat.skip_string_literals === true && !regex.test(stripStringLiterals(code))) return;
        if (pat.pattern.includes("innerHTML") && INNERHTML_CLEAR_RE.test(code)) return;
        sink.push(buildFinding(pat, relPath, lineIndex + 1, code, fileToLayer));
      });
    });
  }

  const findings = perPattern.flat();
  const counters: Record<string, number> = {};
  for (const finding of findings) {
    const prefix = CATEGORY_PREFIX[finding.category] ?? GENERIC_PREFIX;
    counters[prefix] = (counters[prefix] ?? 0) + 1;
  }
  return { findings, counters };
}

// ---- Inventory and flagged-files classification -----------------------------------------

const DEFAULT_ALWAYS_SCAN_LAYERS: readonly string[] = ["services", "middleware", "auth", "security", "api-routes", "handlers", "routes"];
const DEFAULT_ALWAYS_SCAN_PATTERNS: readonly string[] = [
  "main.ts", "main.py", "main.go", "main.rs", "app.ts", "app.py", "server.ts", "server.py", "server.go", "index.ts",
];
const DEFAULT_MIN_IMPORTS = 5;
const DEFAULT_STRUCTURAL_SKIP_EXTENSIONS: readonly string[] = [".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".less", ".env.example"];
const STRUCTURAL_RATIO = 0.9;
const SOURCE_TAG = "SOURCE";

const REEXPORT_RE = /^\s*(?:export\s+\{|export\s+\*|export\s+default\s|export\s+type\s|type\s+\w+\s*=|interface\s+\w+|pub\s+type\s|pub\s+use\s)/;
const NON_CODE_PREFIXES: readonly string[] = ["//", "#", "/*", "*"];

type FlaggedConfig = { layers: readonly string[]; patterns: readonly string[]; minImports: number; skipExtensions: readonly string[] };

function configStrings(key: string, fallback: readonly string[]): readonly string[] {
  const value = configGet(key);
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new TypeError(`${key}: expected a list of strings`);
  return value;
}

// dojutsu.toml's values, or the built-in defaults when the file cannot be found.
function loadFlaggedConfig(): FlaggedConfig {
  try {
    const minImports = configGet("always_scan_files.min_imports");
    if (minImports !== undefined && typeof minImports !== "number") throw new TypeError("always_scan_files.min_imports: expected a number");
    return {
      layers: configStrings("always_scan_layers.layers", DEFAULT_ALWAYS_SCAN_LAYERS),
      patterns: configStrings("always_scan_files.patterns", DEFAULT_ALWAYS_SCAN_PATTERNS),
      minImports: minImports ?? DEFAULT_MIN_IMPORTS,
      skipExtensions: configStrings("structural_skip.extensions_always_skip", DEFAULT_STRUCTURAL_SKIP_EXTENSIONS),
    };
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError)) throw error;
    return { layers: DEFAULT_ALWAYS_SCAN_LAYERS, patterns: DEFAULT_ALWAYS_SCAN_PATTERNS, minImports: DEFAULT_MIN_IMPORTS, skipExtensions: DEFAULT_STRUCTURAL_SKIP_EXTENSIONS };
  }
}

// open(path, errors="replace").readlines() with universal newlines; undefined when unreadable.
function readLinesLossy(path: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(path).toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countImports(path: string): number {
  return (readLinesLossy(path) ?? []).filter((line) => IMPORT_LINE_RE.test(line)).length;
}

// True when at least 90 percent of the file's code lines are type declarations or re-exports.
function isStructuralOnly(path: string): boolean {
  const lines = readLinesLossy(path);
  if (lines === undefined) return false;
  if (lines.length === 0) return true;
  let meaningful = 0;
  let structural = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || NON_CODE_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    meaningful += 1;
    if (REEXPORT_RE.test(line)) structural += 1;
  }
  return meaningful === 0 || structural / meaningful >= STRUCTURAL_RATIO;
}

// os.path.splitext's extension: the last dot of the basename, unless only dots precede it.
function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && /[^.]/.test(name.slice(0, dot)) ? name.slice(dot) : "";
}

type FlaggedEntry = { path: string; layer: string; reason: string };
type FlaggedFiles = { flagged: FlaggedEntry[]; always_scan: FlaggedEntry[]; structural_only: FlaggedEntry[]; llm_scan: FlaggedEntry[] };

function readInventoryFiles(inventoryPath: string): { path: string; tag: string; layer: string }[] {
  const inventory: unknown = JSON.parse(readTextStrict(inventoryPath));
  if (!isRecord(inventory) || !Array.isArray(inventory["files"])) throw new TypeError(`${inventoryPath}: expected an object with a files list`);
  return inventory["files"].map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry["path"] !== "string") throw new TypeError(`${inventoryPath}: every file needs a path`);
    const tag = entry["tag"];
    const layer = entry["layer"];
    return { path: entry["path"], tag: typeof tag === "string" ? tag : SOURCE_TAG, layer: typeof layer === "string" ? layer : DEFAULT_LAYER };
  });
}

export function loadInventory(auditDir: string): { sourceFiles: string[]; stack: string; fileToLayer: Record<string, string> } {
  const inventoryPath = join(auditDir, "data", "inventory.json");
  const files = readInventoryFiles(inventoryPath);
  const inventory: unknown = JSON.parse(readTextStrict(inventoryPath));
  const stack = isRecord(inventory) && typeof inventory["stack"] === "string" ? inventory["stack"] : "unknown";
  return {
    sourceFiles: files.filter((file) => file.tag === SOURCE_TAG).map((file) => file.path),
    stack,
    fileToLayer: Object.fromEntries(files.map((file) => [file.path, file.layer])),
  };
}

// Classifies every inventory file and writes data/flagged-files.json: grep hits first, then
// structural-only files, then the always-scan rules, and everything else for the LLM scan.
function generateFlaggedFiles(auditDir: string, findings: readonly ScannerFinding[], projectDir: string | undefined): void {
  const config = loadFlaggedConfig();
  const flaggedSet = new Set(findings.map((finding) => finding.file));
  const result: FlaggedFiles = { flagged: [], always_scan: [], structural_only: [], llm_scan: [] };

  for (const { path, layer } of readInventoryFiles(join(auditDir, "data", "inventory.json"))) {
    const entry = (reason: string): FlaggedEntry => ({ path, layer, reason });
    const absPath = projectDir === undefined || projectDir === "" ? undefined : join(projectDir, path);
    const extension = extensionOf(path);
    if (flaggedSet.has(path)) result.flagged.push(entry("grep_finding"));
    else if (config.skipExtensions.includes(extension)) result.structural_only.push(entry(`skip_extension:${extension}`));
    else if (absPath !== undefined && isStructuralOnly(absPath)) result.structural_only.push(entry("type_decl_or_reexport"));
    else if (config.layers.includes(layer)) result.always_scan.push(entry(`always_scan_layer:${layer}`));
    else if (config.patterns.includes(basename(path))) result.always_scan.push(entry("entry_point_pattern"));
    else if (absPath !== undefined && countImports(absPath) >= config.minImports) result.always_scan.push(entry("high_import_count"));
    else result.llm_scan.push(entry("default"));
  }

  const outputPath = join(auditDir, "data", "flagged-files.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, dumpJson(result));
}

// Writes the scanner's jsonl, status, scope map and flagged-files; returns the jsonl path.
export function writeResults(auditDir: string, findings: readonly ScannerFinding[], sourceFiles: readonly string[], projectDir?: string): string {
  const outputDir = join(auditDir, "data", "scanner-output");
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, "grep-scanner.jsonl");
  writeFileSync(outputFile, findings.map((finding) => pyJsonDumps(finding) + "\n").join(""));

  const scopeMapPath = join(outputDir, "scope-map.json");
  let scopeMap: Record<string, unknown> = {};
  if (existsSync(scopeMapPath)) {
    const existing: unknown = JSON.parse(readTextStrict(scopeMapPath));
    if (!isRecord(existing)) throw new TypeError(`${scopeMapPath}: expected a JSON object`);
    scopeMap = existing;
  }
  scopeMap[SCANNER_NAME] = sourceFiles;
  writeFileSync(scopeMapPath, dumpJson(scopeMap));

  writeFileSync(join(outputDir, `${SCANNER_NAME}.status`), `COMPLETE ${findings.length}\n`);
  generateFlaggedFiles(auditDir, findings, projectDir);
  return outputFile;
}

// The summary the CLI prints: counts first, then one line per category prefix, largest first.
export function formatSummary(findings: readonly ScannerFinding[], patternsCount: number, filesCount: number, counters: Readonly<Record<string, number>>): string {
  const removable = findings.filter((finding) => finding.target_code !== null).length;
  const lines = [
    `GREP_SCAN_COMPLETE: ${findings.length} findings from ${patternsCount} patterns across ${filesCount} files`,
    `  With target_code (removable): ${removable}`,
    `  Needing enrichment: ${findings.length - removable}`,
  ];
  for (const [prefix, count] of Object.entries(counters).sort(([, a], [, b]) => b - a)) lines.push(`  ${prefix}: ${count}`);
  return lines.join("\n");
}
