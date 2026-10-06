#!/usr/bin/env bun
// Byakugan dependency graph builder.
// Reads inventory.json and source files from a project directory, extracts
// import/require/re-export statements, resolves paths, and writes the dependency graph as JSON.
// Usage: build_dependency_graph.ts <project_dir>
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, roundToTenth } from "@quality/py-format.ts";

const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_FILES: readonly string[] = TS_EXTENSIONS.map((ext) => `index${ext}`);
const TS_STACKS: ReadonlySet<string> = new Set(["typescript", "ts", "javascript", "js", "nextjs", "react", "next"]);
const PYTHON_STACKS: ReadonlySet<string> = new Set(["python", "py"]);
const JVM_STACKS: ReadonlySet<string> = new Set(["java", "kotlin", "jvm"]);
const DEFAULT_STACK = "unknown";
const DEFAULT_BASE_URL = ".";

// \w and \s in the patterns below are the Unicode classes the retired scripts matched with.
const WORD = String.raw`[\p{L}\p{N}_]`;
const SPEC = String.raw`['"](?<specifier>[^'"]+)['"]`;
const IMPORT_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+${WORD}+|${WORD}+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+${WORD}+))?\s+from\s+${SPEC}`,
    "gu",
  ),
  new RegExp(String.raw`import\s+${SPEC}`, "gu"),
  new RegExp(String.raw`require\(\s*${SPEC}\s*\)`, "gu"),
  new RegExp(String.raw`import\(\s*${SPEC}\s*\)`, "gu"),
  new RegExp(String.raw`export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+${WORD}+)?)\s+from\s+${SPEC}`, "gu"),
];
const NAMED_IMPORT = new RegExp(String.raw`(?:import|export)\s+(?:type\s+)?(?:${WORD}+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]`, "gu");
const DEFAULT_IMPORT = new RegExp(String.raw`import\s+(${WORD}+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]`, "gu");
const LINE_COMMENT = /\/\/.*/g;
const AS_SEPARATOR = " as ";
const TYPE_KEYWORD = "type";

export type GraphEdge = { from: string; to: string; imports: string[] };
export type DependencyGraph = {
  generated_at: string;
  project_dir: string;
  stack: string;
  stats: { total_files: number; total_edges: number; avg_imports_per_file: number };
  nodes: { file: string }[];
  edges: GraphEdge[];
  reverse_map: Record<string, string[]>;
  note?: string;
  warning?: string;
};

function join2(base: string, rest: string): string {
  return isAbsolute(rest) ? rest : `${base}/${rest}`;
}

// Path.resolve(): symlinks of the existing prefix are followed, the missing tail is normalized.
function resolveReal(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolveReal(parent), basename(absolute));
  }
}

// pathlib's name and suffix rules: "." parts vanish and a dot only starts a suffix mid-name.
function withSuffix(path: string, ext: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const name = parts[parts.length - 1];
  if (name === undefined) throw new Error(`${path} has an empty name`);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  return `${path.slice(0, path.lastIndexOf(name))}${stem}${ext}`;
}

function loadInventory(projectDir: string): { stack: string; files: string[] } {
  const inventoryPath = join(projectDir, "docs", "audit", "data", "inventory.json");
  if (!existsSync(inventoryPath)) {
    console.error(`ERROR: inventory.json not found at ${inventoryPath}`);
    process.exit(1);
  }
  const data: unknown = JSON.parse(readTextStrict(inventoryPath));
  if (!isRecord(data)) throw new TypeError("inventory.json: expected an object");
  const stack = data["stack"] ?? DEFAULT_STACK;
  if (typeof stack !== "string") throw new TypeError("inventory.json: stack must be a string");
  const files: string[] = [];
  const entries = data["files"];
  if (Array.isArray(entries)) {
    for (const entry of entries as unknown[]) {
      if (typeof entry === "string") files.push(entry);
      else if (isRecord(entry) && "path" in entry) files.push(String(entry["path"]));
    }
  }
  return { stack, files };
}

// tsconfig compilerOptions.paths as {prefix: replacement}: {"@/*": "./src/*"} gives {"@/": "src/"}.
function loadPathAliases(projectDir: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const tsconfigPath = join(projectDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return aliases;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(tsconfigPath, "utf8").replace(LINE_COMMENT, ""));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "EISDIR") return aliases;
    throw error;
  }
  if (!isRecord(config)) throw new TypeError("tsconfig.json: expected an object");
  const options = isRecord(config["compilerOptions"]) ? config["compilerOptions"] : {};
  const baseUrl = typeof options["baseUrl"] === "string" ? options["baseUrl"] : DEFAULT_BASE_URL;
  const paths = isRecord(options["paths"]) ? options["paths"] : {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const prefix = pattern.replaceAll("*", "");
    const target = String(targets[0]).replaceAll("*", "");
    let resolved = isAbsolute(target) ? posix.normalize(target) : posix.normalize(posix.join(baseUrl, target));
    if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
    aliases.set(prefix, resolved.endsWith("/") ? resolved : `${resolved}/`);
  }
  return aliases;
}

// A project-relative file path for an import specifier, or undefined (external or unresolved).
function resolveSpecifier(specifier: string, importer: string, projectDir: string, aliases: Map<string, string>, fileSet: ReadonlySet<string>): string | undefined {
  const isRelative = specifier.startsWith(".");
  let target = specifier;
  if (!isRelative) {
    let matched = false;
    for (const [prefix, replacement] of aliases) {
      if (target.startsWith(prefix)) {
        target = replacement + target.slice(prefix.length);
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  const base = isRelative ? join2(dirname(importer), target) : join2(projectDir, target);
  const candidates: string[] = [base];
  for (const ext of TS_EXTENSIONS) candidates.push(withSuffix(base, ext), base + ext);
  for (const index of INDEX_FILES) candidates.push(`${base}/${index}`);
  const root = resolveReal(projectDir);
  for (const candidate of candidates) {
    const rel = relative(root, resolveReal(candidate));
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (fileSet.has(rel)) return rel;
  }
  return undefined;
}

// [specifier, imported names] in discovery order: named imports, default imports, then every
// other import form.
function extractImports(content: string): [string, string[]][] {
  const specifierNames = new Map<string, string[]>();
  const namesFor = (specifier: string): string[] => {
    const existing = specifierNames.get(specifier);
    if (existing !== undefined) return existing;
    const created: string[] = [];
    specifierNames.set(specifier, created);
    return created;
  };
  for (const match of content.matchAll(NAMED_IMPORT)) {
    const [, namesRaw = "", specifier = ""] = match;
    const names = namesRaw
      .split(",")
      .filter((name) => name.trim() !== "")
      .map((name) => (name.trim().split(AS_SEPARATOR)[0] ?? "").trim());
    namesFor(specifier).push(...names);
  }
  for (const match of content.matchAll(DEFAULT_IMPORT)) {
    const [, name = "", specifier = ""] = match;
    if (name !== TYPE_KEYWORD) namesFor(specifier).push(name);
  }
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) namesFor(match.groups?.["specifier"] ?? "");
  }
  return [...specifierNames];
}

function readLossy(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return new TextDecoder("utf-8").decode(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return undefined;
    throw error;
  }
}

export function buildGraphTypescript(projectDir: string, files: string[]): DependencyGraph {
  const aliases = loadPathAliases(projectDir);
  const fileSet = new Set(files);
  const nodes: { file: string }[] = [];
  const edges: GraphEdge[] = [];
  const reverseMap: Record<string, string[]> = {};

  for (const relFile of files) {
    nodes.push({ file: relFile });
    const absPath = join(projectDir, relFile);
    const content = readLossy(absPath);
    if (content === undefined) continue;
    const seenTargets = new Set<string>();
    for (const [specifier, names] of extractImports(content)) {
      const target = resolveSpecifier(specifier, absPath, projectDir, aliases, fileSet);
      if (target === undefined || target === relFile || seenTargets.has(target)) continue;
      seenTargets.add(target);
      edges.push({ from: relFile, to: target, imports: names });
      (reverseMap[target] ??= []).push(relFile);
    }
  }

  const totalFiles = nodes.length;
  const totalEdges = edges.length;
  return {
    generated_at: nowIso(),
    project_dir: resolveReal(projectDir),
    stack: "typescript",
    stats: { total_files: totalFiles, total_edges: totalEdges, avg_imports_per_file: totalFiles ? roundToTenth(totalEdges / totalFiles) : 0 },
    nodes,
    edges,
    reverse_map: reverseMap,
  };
}

export function buildGraphStub(projectDir: string, stack: string, files: string[]): DependencyGraph {
  return {
    generated_at: nowIso(),
    project_dir: resolveReal(projectDir),
    stack,
    stats: { total_files: files.length, total_edges: 0, avg_imports_per_file: 0 },
    nodes: files.map((file) => ({ file })),
    edges: [],
    reverse_map: {},
    note: `Dependency analysis not yet implemented for '${stack}'. Only file nodes are listed.`,
  };
}

if (import.meta.main) {
  const [projectArg] = process.argv.slice(2);
  if (projectArg === undefined) {
    console.error("Usage: bun build_dependency_graph.ts <project_dir>");
    process.exit(1);
  }
  const projectDir = resolveReal(projectArg);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    console.error(`ERROR: ${projectDir} is not a directory`);
    process.exit(1);
  }
  const { stack, files } = loadInventory(projectDir);
  const lowered = stack.toLowerCase();
  let graph: DependencyGraph;
  if (TS_STACKS.has(lowered)) {
    graph = buildGraphTypescript(projectDir, files);
  } else if (PYTHON_STACKS.has(lowered) || JVM_STACKS.has(lowered)) {
    graph = buildGraphStub(projectDir, stack, files);
  } else {
    console.log(`WARNING: Dependency graph not implemented for stack '${stack}'.`);
    console.log("  Byakugan will proceed with finding-level analysis only (no blast radius tracing).");
    graph = buildGraphStub(projectDir, stack, files);
    graph.warning = `No dependency analysis available for '${stack}'. Impact analysis will be limited.`;
  }
  const outDir = join(projectDir, "docs", "audit", "deep");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "dependency-graph.json");
  writeFileSync(outPath, dumpJson(graph));
  console.log(`Built dependency graph: ${graph.stats.total_files} nodes, ${graph.stats.total_edges} edges`);
  console.log(`Output: ${outPath}`);
}
