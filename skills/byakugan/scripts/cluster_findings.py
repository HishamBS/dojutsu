#!/usr/bin/env python3
"""Usage: cluster_findings.py <project_dir>
Reads findings.jsonl + dependency-graph.json, clusters findings by file,
import connectivity, and cross-cutting patterns. Outputs clusters.json.
Deterministic — no LLM needed."""
import json, os, sys
from collections import defaultdict
from datetime import datetime, timezone

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "REVIEW": 4}
MERGE_OVERLAP_THRESHOLD = 0.5
DESC_PREFIX_LEN = 50


def load_findings(project_dir: str) -> list:
    path = os.path.join(project_dir, "docs", "audit", "data", "findings.jsonl")
    findings = []
    if not os.path.exists(path):
        print(f"WARNING: {path} not found, no findings to cluster")
        return findings
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                findings.append(json.loads(line))
    return findings


def load_dep_graph(project_dir: str) -> dict:
    path = os.path.join(project_dir, "docs", "audit", "deep", "dependency-graph.json")
    if not os.path.exists(path):
        print(f"WARNING: {path} not found, skipping import clusters")
        return {}
    with open(path, "r") as f:
        return json.load(f)


# --- Union-Find ---

class UnionFind:
    def __init__(self, items: list):
        self.parent = {item: item for item in items}
        self.rank = {item: 0 for item in items}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1

    def groups(self) -> dict:
        result: dict = defaultdict(set)
        for item in self.parent:
            result[self.find(item)].add(item)
        return dict(result)


# --- Clustering strategies ---

def cluster_by_file(findings: list) -> list:
    by_file: dict = defaultdict(list)
    for f in findings:
        by_file[f.get("file", "unknown")].append(f)
    clusters = []
    for filepath, group in by_file.items():
        if not group:
            continue
        clusters.append({
            "type": "file",
            "files": [filepath],
            "findings": group,
        })
    return clusters


def cluster_by_imports(findings: list, dep_graph: dict) -> list:
    if not dep_graph:
        return []

    files_with_findings = set()
    findings_by_file: dict = defaultdict(list)
    for f in findings:
        fp = f.get("file", "")
        if fp:
            files_with_findings.add(fp)
            findings_by_file[fp].append(f)

    if not files_with_findings:
        return []

    adjacency: dict = defaultdict(set)
    nodes = dep_graph.get("nodes", dep_graph.get("files", {}))

    if isinstance(nodes, dict):
        for src, targets in nodes.items():
            if isinstance(targets, list):
                for tgt in targets:
                    tgt_str = tgt if isinstance(tgt, str) else tgt.get("file", tgt.get("target", ""))
                    if src in files_with_findings and tgt_str in files_with_findings:
                        adjacency[src].add(tgt_str)
                        adjacency[tgt_str].add(src)
    elif isinstance(nodes, list):
        edges = dep_graph.get("edges", dep_graph.get("links", []))
        for edge in edges:
            src = edge.get("source", edge.get("from", ""))
            tgt = edge.get("target", edge.get("to", ""))
            if src in files_with_findings and tgt in files_with_findings:
                adjacency[src].add(tgt)
                adjacency[tgt].add(src)

    connected_files = set()
    for src, targets in adjacency.items():
        connected_files.add(src)
        connected_files.update(targets)

    if not connected_files:
        return []

    uf = UnionFind(list(connected_files))
    for src, targets in adjacency.items():
        for tgt in targets:
            uf.union(src, tgt)

    clusters = []
    for _root, members in uf.groups().items():
        group_findings = []
        for fp in members:
            group_findings.extend(findings_by_file.get(fp, []))
        if group_findings:
            clusters.append({
                "type": "import_connected",
                "files": sorted(members),
                "findings": group_findings,
            })
    return clusters


def cluster_cross_cutting(findings: list) -> list:
    by_group: dict = defaultdict(list)
    by_rule_desc: dict = defaultdict(list)

    for f in findings:
        group = f.get("group")
        if group:
            by_group[group].append(f)

        rule = f.get("rule", "")
        desc = f.get("description", "")
        if rule and desc:
            key = (rule, desc[:DESC_PREFIX_LEN])
            by_rule_desc[key].append(f)

    seen_ids: set = set()
    clusters = []

    for group_name, group_findings in by_group.items():
        if len(group_findings) < 2:
            continue
        fids = {f.get("id", "") for f in group_findings}
        clusters.append({
            "type": "cross_cutting",
            "files": sorted({f.get("file", "") for f in group_findings}),
            "findings": group_findings,
            "source": "group",
        })
        seen_ids.update(fids)

    for (rule, desc_prefix), group_findings in by_rule_desc.items():
        if len(group_findings) < 2:
            continue
        fids = {f.get("id", "") for f in group_findings}
        if fids <= seen_ids:
            continue
        clusters.append({
            "type": "cross_cutting",
            "files": sorted({f.get("file", "") for f in group_findings}),
            "findings": group_findings,
            "source": "rule_desc",
        })
        seen_ids.update(fids)

    return clusters


# --- Merge overlapping clusters ---

def finding_ids(cluster: dict) -> set:
    return {f.get("id", "") for f in cluster["findings"]}


def merge_overlapping(clusters: list) -> list:
    if not clusters:
        return []

    merged = True
    while merged:
        merged = False
        result = []
        used = [False] * len(clusters)
        for i in range(len(clusters)):
            if used[i]:
                continue
            current = clusters[i]
            current_ids = finding_ids(current)
            for j in range(i + 1, len(clusters)):
                if used[j]:
                    continue
                other_ids = finding_ids(clusters[j])
                if not current_ids or not other_ids:
                    continue
                overlap = len(current_ids & other_ids)
                smaller = min(len(current_ids), len(other_ids))
                if smaller > 0 and overlap / smaller > MERGE_OVERLAP_THRESHOLD:
                    current_ids |= other_ids
                    existing_findings_map = {f.get("id", ""): f for f in current["findings"]}
                    for f in clusters[j]["findings"]:
                        fid = f.get("id", "")
                        if fid not in existing_findings_map:
                            current["findings"].append(f)
                            existing_findings_map[fid] = f
                    current["files"] = sorted(
                        set(current["files"]) | set(clusters[j]["files"])
                    )
                    if len(clusters[j]["findings"]) > len(clusters[i]["findings"]):
                        current["type"] = clusters[j]["type"]
                    used[j] = True
                    merged = True
            result.append(current)
        clusters = result

    return clusters


# --- Formatting ---

def max_severity(findings: list) -> str:
    best = "REVIEW"
    for f in findings:
        sev = f.get("severity", "REVIEW")
        if SEVERITY_ORDER.get(sev, 99) < SEVERITY_ORDER.get(best, 99):
            best = sev
    return best


def extract_rules(findings: list) -> list:
    return sorted({f.get("rule", "") for f in findings if f.get("rule")})


def derive_name(findings: list) -> str:
    if not findings:
        return "Empty cluster"
    top = min(findings, key=lambda f: SEVERITY_ORDER.get(f.get("severity", "REVIEW"), 99))
    desc = top.get("description", "No description")
    return desc[:80]


def derive_root_pattern(findings: list) -> str:
    if not findings:
        return ""
    desc_counts: dict = defaultdict(int)
    for f in findings:
        prefix = f.get("description", "")[:DESC_PREFIX_LEN]
        if prefix:
            desc_counts[prefix] += 1
    if not desc_counts:
        return ""
    return max(desc_counts, key=desc_counts.get)


def format_clusters(clusters: list) -> list:
    formatted = []
    for idx, cluster in enumerate(clusters, 1):
        findings = cluster["findings"]
        formatted.append({
            "id": f"CLU-{idx:03d}",
            "type": cluster["type"],
            "name": derive_name(findings),
            "files": sorted(set(cluster["files"])),
            "finding_ids": sorted({f.get("id", "") for f in findings}),
            "finding_count": len({f.get("id", "") for f in findings}),
            "max_severity": max_severity(findings),
            "rules": extract_rules(findings),
            "root_pattern": derive_root_pattern(findings),
        })
    formatted.sort(key=lambda c: (SEVERITY_ORDER.get(c["max_severity"], 99), -c["finding_count"]))
    for idx, cluster in enumerate(formatted, 1):
        cluster["id"] = f"CLU-{idx:03d}"
    return formatted


def compute_stats(formatted: list) -> dict:
    total_findings = set()
    type_counts: dict = defaultdict(int)
    largest = 0
    for c in formatted:
        total_findings.update(c["finding_ids"])
        type_counts[c["type"]] += 1
        if c["finding_count"] > largest:
            largest = c["finding_count"]
    n = len(formatted)
    total = len(total_findings)
    return {
        "total_clusters": n,
        "total_findings_clustered": total,
        "avg_findings_per_cluster": round(total / n, 1) if n else 0,
        "largest_cluster_size": largest,
        "cross_cutting_clusters": type_counts.get("cross_cutting", 0),
        "import_connected_clusters": type_counts.get("import_connected", 0),
        "file_clusters": type_counts.get("file", 0),
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: cluster_findings.py <project_dir>", file=sys.stderr)
        sys.exit(1)

    project_dir = sys.argv[1]
    findings = load_findings(project_dir)
    if not findings:
        print("Clustered 0 findings into 0 clusters")
        return

    dep_graph = load_dep_graph(project_dir)

    file_clusters = cluster_by_file(findings)
    import_clusters = cluster_by_imports(findings, dep_graph)
    cross_clusters = cluster_cross_cutting(findings)

    all_clusters = file_clusters + import_clusters + cross_clusters
    all_clusters = merge_overlapping(all_clusters)
    formatted = format_clusters(all_clusters)
    stats = compute_stats(formatted)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "clusters": formatted,
        "stats": stats,
    }

    out_dir = os.path.join(project_dir, "docs", "audit", "deep")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "clusters.json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Clustered {stats['total_findings_clustered']} findings into {stats['total_clusters']} clusters")


if __name__ == "__main__":
    main()
