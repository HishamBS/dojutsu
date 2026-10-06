#!/usr/bin/env bun
// Usage: cluster_findings.ts <project_dir>
// Reads findings.jsonl + dependency-graph.json, clusters findings by file, import connectivity
// and cross-cutting patterns, and writes clusters.json. Deterministic - no LLM needed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpJson, isRecord, readTextStrict } from "@quality/io.ts";
import { nowIso, pyJsonDumps, pyStr, roundToTenth } from "@quality/py-format.ts";

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, REVIEW: 4 };
const UNRANKED_SEVERITY = 99;
const DEFAULT_SEVERITY = "REVIEW";
const MERGE_OVERLAP_THRESHOLD = 0.5;
const DESC_PREFIX_LEN = 50;
const NAME_PREFIX_LEN = 80;
const PATTERN_KEY_LEN = 120;
const MAX_CLUSTER_SIZE = 12;
const MAX_RULES_PER_CLUSTER = 2;
const PATTERN_KEY_FIELDS: readonly string[] = ["cross_cutting_group", "search_pattern", "current_code", "snippet", "description"];
const ID_DIGITS = 3;

export type Finding = Record<string, unknown>;
type RawCluster = { type: string; files: string[]; findings: Finding[]; source?: string };
export type FormattedCluster = {
  id: string;
  type: string;
  name: string;
  files: string[];
  finding_ids: string[];
  finding_count: number;
  max_severity: string;
  rules: string[];
  root_pattern: string;
};
export type ClusterStats = {
  total_clusters: number;
  total_findings_clustered: number;
  avg_findings_per_cluster: number;
  largest_cluster_size: number;
  cross_cutting_clusters: number;
  import_connected_clusters: number;
  file_clusters: number;
};
export type ClusterResult = { clusters: FormattedCluster[]; stats: ClusterStats; annotated: number; published: boolean };

function strField(finding: Finding, key: string, fallback: string): string {
  const value = finding[key];
  return value === undefined ? fallback : pyStr(value);
}

// s[:n] counts code points, not UTF-16 units.
function prefix(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

// int(value or 0)
function lineNumber(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "number") return Math.trunc(value);
  const text = pyStr(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new TypeError(`invalid literal for int(): ${JSON.stringify(text)}`);
  return Number(text);
}

function severityRank(severity: string): number {
  return SEVERITY_ORDER[severity] ?? UNRANKED_SEVERITY;
}

function findingsPath(projectDir: string): string {
  return join(projectDir, "docs", "audit", "data", "findings.jsonl");
}

function loadFindings(projectDir: string): { findings: Finding[]; exists: boolean } {
  const path = findingsPath(projectDir);
  if (!existsSync(path)) {
    console.log(`WARNING: ${path} not found, no findings to cluster`);
    return { findings: [], exists: false };
  }
  const findings: Finding[] = [];
  for (const raw of readTextStrict(path).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new TypeError("findings.jsonl: a finding is not an object");
    findings.push(parsed);
  }
  return { findings, exists: true };
}

function loadDependencyGraph(projectDir: string): Record<string, unknown> {
  const path = join(projectDir, "docs", "audit", "deep", "dependency-graph.json");
  if (!existsSync(path)) {
    console.log(`WARNING: ${path} not found, skipping import clusters`);
    return {};
  }
  const graph: unknown = JSON.parse(readTextStrict(path));
  if (isRecord(graph)) return graph;
  if (graph === null || graph === false || graph === 0 || graph === "" || (Array.isArray(graph) && graph.length === 0)) return {};
  throw new TypeError("dependency-graph.json: expected an object");
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  constructor(items: string[]) {
    for (const item of items) {
      this.parent.set(item, item);
      this.rank.set(item, 0);
    }
  }

  find(item: string): string {
    let current = item;
    for (;;) {
      const up = this.parent.get(current) ?? current;
      if (up === current) return current;
      const grand = this.parent.get(up) ?? up;
      this.parent.set(current, grand);
      current = grand;
    }
  }

  union(a: string, b: string): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) [rootA, rootB] = [rootB, rootA];
    this.parent.set(rootB, rootA);
    if (rankA === rankB) this.rank.set(rootA, (this.rank.get(rootA) ?? 0) + 1);
  }

  groups(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const item of this.parent.keys()) {
      const root = this.find(item);
      const members = result.get(root) ?? new Set<string>();
      members.add(item);
      result.set(root, members);
    }
    return result;
  }
}

function clusterByFile(findings: Finding[]): RawCluster[] {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const file = strField(finding, "file", "unknown");
    const group = byFile.get(file) ?? [];
    group.push(finding);
    byFile.set(file, group);
  }
  return [...byFile].map(([file, group]) => ({ type: "file", files: [file], findings: group }));
}

function addEdge(adjacency: Map<string, Set<string>>, from: string, to: string, withFindings: ReadonlySet<string>): void {
  if (!withFindings.has(from) || !withFindings.has(to)) return;
  for (const [a, b] of [[from, to], [to, from]] as const) {
    const neighbours = adjacency.get(a) ?? new Set<string>();
    neighbours.add(b);
    adjacency.set(a, neighbours);
  }
}

function targetName(target: unknown): string {
  if (typeof target === "string") return target;
  if (!isRecord(target)) throw new TypeError("dependency graph: a target is neither a string nor an object");
  return strField(target, "file", strField(target, "target", ""));
}

function clusterByImports(findings: Finding[], depGraph: Record<string, unknown>): RawCluster[] {
  if (Object.keys(depGraph).length === 0) return [];
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const file = strField(finding, "file", "");
    if (file === "") continue;
    const group = findingsByFile.get(file) ?? [];
    group.push(finding);
    findingsByFile.set(file, group);
  }
  if (findingsByFile.size === 0) return [];
  const withFindings = new Set(findingsByFile.keys());

  const adjacency = new Map<string, Set<string>>();
  const nodes = "nodes" in depGraph ? depGraph["nodes"] : "files" in depGraph ? depGraph["files"] : {};
  if (isRecord(nodes)) {
    for (const [source, targets] of Object.entries(nodes)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets as unknown[]) addEdge(adjacency, source, targetName(target), withFindings);
    }
  } else if (Array.isArray(nodes)) {
    const edges = "edges" in depGraph ? depGraph["edges"] : "links" in depGraph ? depGraph["links"] : [];
    for (const edge of Array.isArray(edges) ? (edges as unknown[]) : []) {
      if (!isRecord(edge)) throw new TypeError("dependency graph: an edge is not an object");
      const source = strField(edge, "source", strField(edge, "from", ""));
      const target = strField(edge, "target", strField(edge, "to", ""));
      addEdge(adjacency, source, target, withFindings);
    }
  }

  const connected = sortedUnique([...adjacency.keys(), ...[...adjacency.values()].flatMap((targets) => [...targets])]);
  if (connected.length === 0) return [];
  const unionFind = new UnionFind(connected);
  for (const [source, targets] of adjacency) for (const target of targets) unionFind.union(source, target);

  const clusters: RawCluster[] = [];
  for (const members of unionFind.groups().values()) {
    const ordered = [...members].sort(compareText);
    const groupFindings = ordered.flatMap((file) => findingsByFile.get(file) ?? []);
    if (groupFindings.length > 0) clusters.push({ type: "import_connected", files: ordered, findings: groupFindings });
  }
  return clusters;
}

function idSet(findings: Finding[]): Set<string> {
  return new Set(findings.map((finding) => strField(finding, "id", "")));
}

function fileList(findings: Finding[]): string[] {
  return sortedUnique(findings.map((finding) => strField(finding, "file", "")));
}

function clusterCrossCutting(findings: Finding[]): RawCluster[] {
  const byGroup = new Map<string, Finding[]>();
  const byRuleDesc = new Map<string, Finding[]>();
  const push = (map: Map<string, Finding[]>, key: string, finding: Finding): void => {
    const group = map.get(key) ?? [];
    group.push(finding);
    map.set(key, group);
  };
  for (const finding of findings) {
    const group = finding["cross_cutting_group"];
    if (group) push(byGroup, pyStr(group), finding);
    const rule = strField(finding, "rule", "");
    const desc = strField(finding, "description", "");
    if (rule !== "" && desc !== "") push(byRuleDesc, JSON.stringify([rule, prefix(desc, DESC_PREFIX_LEN)]), finding);
  }

  const seenIds = new Set<string>();
  const clusters: RawCluster[] = [];
  for (const groupFindings of byGroup.values()) {
    if (groupFindings.length < 2) continue;
    clusters.push({ type: "cross_cutting", files: fileList(groupFindings), findings: groupFindings, source: "cross_cutting_group" });
    for (const id of idSet(groupFindings)) seenIds.add(id);
  }
  for (const groupFindings of byRuleDesc.values()) {
    if (groupFindings.length < 2) continue;
    const ids = idSet(groupFindings);
    if ([...ids].every((id) => seenIds.has(id))) continue;
    clusters.push({ type: "cross_cutting", files: fileList(groupFindings), findings: groupFindings, source: "rule_desc" });
    for (const id of ids) seenIds.add(id);
  }
  return clusters;
}

function normalizeText(value: string): string {
  const spaced = Array.from(value.toLowerCase(), (char) => (/[\p{L}\p{N}]/u.test(char) ? char : " ")).join("");
  return spaced.split(/\s+/).filter(Boolean).join(" ");
}

function findingPatternKey(finding: Finding): string {
  for (const field of PATTERN_KEY_FIELDS) {
    const value = finding[field];
    if (typeof value === "string" && value.trim() !== "") return prefix(normalizeText(value), PATTERN_KEY_LEN);
  }
  return prefix(normalizeText(strField(finding, "id", "")), PATTERN_KEY_LEN);
}

function shouldSplit(cluster: RawCluster): boolean {
  if (cluster.findings.length > MAX_CLUSTER_SIZE) return true;
  const rules = new Set(cluster.findings.map((finding) => strField(finding, "rule", "")).filter((rule) => rule !== ""));
  return rules.size > MAX_RULES_PER_CLUSTER;
}

function splitMembers(findings: Finding[]): Finding[][] {
  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const rule = strField(finding, "rule", "UNKNOWN");
    byRule.set(rule, [...(byRule.get(rule) ?? []), finding]);
  }
  const groups: Finding[][] = [];
  for (const members of byRule.values()) {
    const byPattern = new Map<string, Finding[]>();
    for (const finding of members) {
      const key = findingPatternKey(finding);
      byPattern.set(key, [...(byPattern.get(key) ?? []), finding]);
    }
    for (const subgroup of byPattern.values()) {
      const ordered = [...subgroup].sort(
        (a, b) =>
          compareText(strField(a, "file", ""), strField(b, "file", "")) ||
          lineNumber(a["line"]) - lineNumber(b["line"]) ||
          compareText(strField(a, "id", ""), strField(b, "id", "")),
      );
      for (let start = 0; start < ordered.length; start += MAX_CLUSTER_SIZE) groups.push(ordered.slice(start, start + MAX_CLUSTER_SIZE));
    }
  }
  return groups.filter((group) => group.length > 0);
}

function splitMixedClusters(clusters: RawCluster[]): RawCluster[] {
  const result: RawCluster[] = [];
  for (const cluster of clusters) {
    if (!shouldSplit(cluster)) {
      result.push(cluster);
      continue;
    }
    for (const subgroup of splitMembers(cluster.findings)) result.push({ type: cluster.type, files: fileList(subgroup), findings: subgroup });
  }
  return result;
}

function mergeOverlapping(input: RawCluster[]): RawCluster[] {
  let clusters = input;
  let merged = clusters.length > 0;
  while (merged) {
    merged = false;
    const result: RawCluster[] = [];
    const used = new Array<boolean>(clusters.length).fill(false);
    clusters.forEach((current, i) => {
      if (used[i]) return;
      const currentIds = idSet(current.findings);
      for (let j = i + 1; j < clusters.length; j += 1) {
        const other = clusters[j];
        if (other === undefined || used[j]) continue;
        const otherIds = idSet(other.findings);
        if (currentIds.size === 0 || otherIds.size === 0) continue;
        const overlap = [...currentIds].filter((id) => otherIds.has(id)).length;
        const smaller = Math.min(currentIds.size, otherIds.size);
        if (smaller > 0 && overlap / smaller > MERGE_OVERLAP_THRESHOLD) {
          for (const id of otherIds) currentIds.add(id);
          const existing = idSet(current.findings);
          for (const finding of other.findings) {
            const id = strField(finding, "id", "");
            if (!existing.has(id)) {
              current.findings.push(finding);
              existing.add(id);
            }
          }
          current.files = sortedUnique([...current.files, ...other.files]);
          if (other.findings.length > current.findings.length) current.type = other.type;
          used[j] = true;
          merged = true;
        }
      }
      result.push(current);
    });
    clusters = result;
  }
  return clusters;
}

function maxSeverity(findings: Finding[]): string {
  let best = DEFAULT_SEVERITY;
  for (const finding of findings) {
    const severity = strField(finding, "severity", DEFAULT_SEVERITY);
    if (severityRank(severity) < severityRank(best)) best = severity;
  }
  return best;
}

function deriveName(findings: Finding[]): string {
  let top = findings[0];
  if (top === undefined) return "Empty cluster";
  for (const finding of findings) {
    if (severityRank(strField(finding, "severity", DEFAULT_SEVERITY)) < severityRank(strField(top, "severity", DEFAULT_SEVERITY))) top = finding;
  }
  return prefix(strField(top, "description", "No description"), NAME_PREFIX_LEN);
}

function deriveRootPattern(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = prefix(strField(finding, "description", ""), DESC_PREFIX_LEN);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

const clusterId = (index: number): string => `CLU-${String(index).padStart(ID_DIGITS, "0")}`;

function formatClusters(clusters: RawCluster[]): FormattedCluster[] {
  const formatted = clusters.map((cluster, index): FormattedCluster => {
    const ids = sortedUnique(cluster.findings.map((finding) => strField(finding, "id", "")));
    return {
      id: clusterId(index + 1),
      type: cluster.type,
      name: deriveName(cluster.findings),
      files: sortedUnique(cluster.files),
      finding_ids: ids,
      finding_count: ids.length,
      max_severity: maxSeverity(cluster.findings),
      rules: sortedUnique(cluster.findings.map((finding) => strField(finding, "rule", "")).filter((rule) => rule !== "")),
      root_pattern: deriveRootPattern(cluster.findings),
    };
  });
  formatted.sort((a, b) => severityRank(a.max_severity) - severityRank(b.max_severity) || b.finding_count - a.finding_count);
  formatted.forEach((cluster, index) => {
    cluster.id = clusterId(index + 1);
  });
  return formatted;
}

function computeStats(formatted: FormattedCluster[]): ClusterStats {
  const allIds = new Set<string>();
  const typeCounts = new Map<string, number>();
  let largest = 0;
  for (const cluster of formatted) {
    for (const id of cluster.finding_ids) allIds.add(id);
    typeCounts.set(cluster.type, (typeCounts.get(cluster.type) ?? 0) + 1);
    largest = Math.max(largest, cluster.finding_count);
  }
  const clusterCount = formatted.length;
  return {
    total_clusters: clusterCount,
    total_findings_clustered: allIds.size,
    avg_findings_per_cluster: clusterCount ? roundToTenth(allIds.size / clusterCount) : 0,
    largest_cluster_size: largest,
    cross_cutting_clusters: typeCounts.get("cross_cutting") ?? 0,
    import_connected_clusters: typeCounts.get("import_connected") ?? 0,
    file_clusters: typeCounts.get("file") ?? 0,
  };
}

// Writes cluster_id back into the published findings dataset; returns how many rows got one.
function annotateFindings(projectDir: string, clusters: FormattedCluster[]): number {
  const { findings } = loadFindings(projectDir);
  if (findings.length === 0) return 0;
  const clusterByFinding = new Map<string, string>();
  for (const cluster of clusters) for (const id of cluster.finding_ids) clusterByFinding.set(id, cluster.id);
  let updated = 0;
  let text = "";
  for (const finding of findings) {
    const id = clusterByFinding.get(strField(finding, "id", ""));
    if (id !== undefined) {
      finding["cluster_id"] = id;
      updated += 1;
    }
    text += pyJsonDumps(finding) + "\n";
  }
  writeFileSync(findingsPath(projectDir), text);
  return updated;
}

export function clusterFindings(projectDir: string): ClusterResult {
  const { findings, exists } = loadFindings(projectDir);
  if (!exists) return { clusters: [], stats: computeStats([]), annotated: 0, published: false };

  let formatted: FormattedCluster[] = [];
  if (findings.length > 0) {
    const depGraph = loadDependencyGraph(projectDir);
    const all = [...clusterByFile(findings), ...clusterByImports(findings, depGraph), ...clusterCrossCutting(findings)];
    formatted = formatClusters(splitMixedClusters(mergeOverlapping(all)));
  }
  const stats = computeStats(formatted);
  const outDir = join(projectDir, "docs", "audit", "deep");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "clusters.json"), dumpJson({ generated_at: nowIso(), clusters: formatted, stats }));
  return { clusters: formatted, stats, annotated: annotateFindings(projectDir, formatted), published: true };
}

if (import.meta.main) {
  const [projectDir] = process.argv.slice(2);
  if (projectDir === undefined) {
    console.error("Usage: cluster_findings.ts <project_dir>");
    process.exit(1);
  }
  const { stats, annotated } = clusterFindings(projectDir);
  if (stats.total_clusters === 0) console.log("Clustered 0 findings into 0 clusters");
  else console.log(`Clustered ${stats.total_findings_clustered} findings into ${stats.total_clusters} clusters; annotated ${annotated} findings`);
}
