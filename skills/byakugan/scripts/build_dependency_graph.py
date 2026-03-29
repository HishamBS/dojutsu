#!/usr/bin/env python3
"""Byakugan dependency graph builder.

Reads inventory.json and source files from a project directory,
extracts import/require/re-export statements, resolves paths,
and outputs a dependency graph as JSON.

Usage: python3 build_dependency_graph.py <project_dir>
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# Extensions to try when resolving bare specifiers
TS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
INDEX_FILES = tuple(f"index{ext}" for ext in TS_EXTENSIONS)

# Regex patterns for TypeScript / JavaScript imports
# Group "specifier" captures the module path in every variant.
_IMPORT_PATTERNS: List[re.Pattern[str]] = [
    # import { X } from 'path'  |  import X from 'path'  |  import * as X from 'path'
    re.compile(
        r"""(?:import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)"""
        r"""(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?\s+from\s+))"""
        r"""['"](?P<specifier>[^'"]+)['"]"""
    ),
    # import 'path'  (side-effect)
    re.compile(r"""import\s+['"](?P<specifier>[^'"]+)['"]"""),
    # require('path')
    re.compile(r"""require\(\s*['"](?P<specifier>[^'"]+)['"]\s*\)"""),
    # import('path')  (dynamic)
    re.compile(r"""import\(\s*['"](?P<specifier>[^'"]+)['"]\s*\)"""),
    # export { X } from 'path'  |  export * from 'path'
    re.compile(
        r"""export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"](?P<specifier>[^'"]+)['"]"""
    ),
]

# Captures named imports:  import { A, B } from '...'
# Also handles:  import Foo, { A, B } from '...'
_NAMED_IMPORT_RE = re.compile(
    r"""(?:import|export)\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]"""
)
# Default import:  import Foo from '...'  or  import Foo, { ... } from '...'
_DEFAULT_IMPORT_RE = re.compile(
    r"""import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]"""
)


def _load_inventory(project_dir: Path) -> Tuple[str, List[str]]:
    """Return (stack, file_list) from inventory.json."""
    inv_path = project_dir / "docs" / "audit" / "data" / "inventory.json"
    if not inv_path.exists():
        print(f"ERROR: inventory.json not found at {inv_path}", file=sys.stderr)
        sys.exit(1)
    with open(inv_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    stack = data.get("stack", "unknown")
    files: List[str] = []
    if "files" in data:
        for entry in data["files"]:
            if isinstance(entry, str):
                files.append(entry)
            elif isinstance(entry, dict) and "path" in entry:
                files.append(entry["path"])
    return stack, files


def _load_path_aliases(project_dir: Path) -> Dict[str, str]:
    """Parse tsconfig.json compilerOptions.paths into {prefix: replacement}.

    Example: {"@/*": "./src/*"} -> {"@/": "src/"}
    """
    aliases: Dict[str, str] = {}
    tsconfig_path = project_dir / "tsconfig.json"
    if not tsconfig_path.exists():
        return aliases
    try:
        with open(tsconfig_path, "r", encoding="utf-8") as fh:
            # Strip single-line comments (tsconfig allows them)
            text = re.sub(r"//.*", "", fh.read())
            cfg = json.loads(text)
    except (json.JSONDecodeError, OSError):
        return aliases

    base_url = cfg.get("compilerOptions", {}).get("baseUrl", ".")
    paths = cfg.get("compilerOptions", {}).get("paths", {})
    for pattern, targets in paths.items():
        if not targets:
            continue
        # Only handle wildcard patterns like "@/*" -> ["./src/*"]
        prefix = pattern.replace("*", "")
        target = targets[0].replace("*", "")
        # Normalize target relative to baseUrl
        resolved = os.path.normpath(os.path.join(base_url, target))
        # Ensure trailing separator so join works
        if not resolved.endswith("/"):
            resolved += "/"
        aliases[prefix] = resolved
    return aliases


def _resolve_specifier(
    specifier: str,
    importer: Path,
    project_dir: Path,
    aliases: Dict[str, str],
    file_set: Set[str],
) -> Optional[str]:
    """Resolve an import specifier to a project-relative file path, or None."""
    # Skip external packages (no leading dot or alias match)
    is_relative = specifier.startswith(".")
    alias_match: Optional[str] = None

    if not is_relative:
        for prefix, replacement in aliases.items():
            if specifier.startswith(prefix):
                remainder = specifier[len(prefix):]
                specifier = replacement + remainder
                alias_match = prefix
                break
        if alias_match is None:
            # External package -- skip
            return None

    # Build absolute base path
    if is_relative:
        base = importer.parent / specifier
    else:
        base = project_dir / specifier

    # Candidates: exact, with extensions, index files
    candidates: List[Path] = [base]
    for ext in TS_EXTENSIONS:
        candidates.append(base.with_suffix(ext))
        candidates.append(Path(str(base) + ext))
    for idx in INDEX_FILES:
        candidates.append(base / idx)

    for candidate in candidates:
        try:
            rel = candidate.resolve().relative_to(project_dir.resolve())
        except (ValueError, OSError):
            continue
        rel_str = str(rel)
        if rel_str in file_set:
            return rel_str

    return None


def _extract_imports(
    content: str,
) -> List[Tuple[str, List[str]]]:
    """Return [(specifier, [imported_names]), ...] from file content."""
    specifier_names: Dict[str, List[str]] = {}

    # Collect named imports
    for m in _NAMED_IMPORT_RE.finditer(content):
        names_raw, spec = m.group(1), m.group(2)
        names = [
            n.strip().split(" as ")[0].strip()
            for n in names_raw.split(",")
            if n.strip()
        ]
        specifier_names.setdefault(spec, []).extend(names)

    # Collect default imports
    for m in _DEFAULT_IMPORT_RE.finditer(content):
        name, spec = m.group(1), m.group(2)
        if name not in ("type",):
            specifier_names.setdefault(spec, []).append(name)

    # Collect all specifiers (ensures side-effect / dynamic / require are included)
    for pat in _IMPORT_PATTERNS:
        for m in pat.finditer(content):
            spec = m.group("specifier")
            specifier_names.setdefault(spec, [])

    return list(specifier_names.items())


def build_graph_typescript(
    project_dir: Path, files: List[str]
) -> Dict:
    """Build the dependency graph for a TypeScript/JS project."""
    aliases = _load_path_aliases(project_dir)
    file_set = set(files)

    nodes: List[Dict] = []
    edges: List[Dict] = []
    reverse_map: Dict[str, List[str]] = {}

    for rel_file in files:
        nodes.append({"file": rel_file})
        abs_path = project_dir / rel_file
        if not abs_path.exists():
            continue
        try:
            content = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        seen_targets: Set[str] = set()
        for specifier, names in _extract_imports(content):
            target = _resolve_specifier(
                specifier, abs_path, project_dir, aliases, file_set
            )
            if target is None or target == rel_file or target in seen_targets:
                continue
            seen_targets.add(target)
            edges.append(
                {"from": rel_file, "to": target, "imports": names}
            )
            reverse_map.setdefault(target, []).append(rel_file)

    total_files = len(nodes)
    total_edges = len(edges)
    avg_imports = round(total_edges / total_files, 1) if total_files else 0.0

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project_dir": str(project_dir.resolve()),
        "stack": "typescript",
        "stats": {
            "total_files": total_files,
            "total_edges": total_edges,
            "avg_imports_per_file": avg_imports,
        },
        "nodes": nodes,
        "edges": edges,
        "reverse_map": reverse_map,
    }


def build_graph_stub(project_dir: Path, stack: str, files: List[str]) -> Dict:
    """Return an empty graph for unsupported stacks."""
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project_dir": str(project_dir.resolve()),
        "stack": stack,
        "stats": {"total_files": len(files), "total_edges": 0, "avg_imports_per_file": 0.0},
        "nodes": [{"file": f} for f in files],
        "edges": [],
        "reverse_map": {},
        "note": f"Dependency analysis not yet implemented for '{stack}'. Only file nodes are listed.",
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 build_dependency_graph.py <project_dir>", file=sys.stderr)
        sys.exit(1)

    project_dir = Path(sys.argv[1]).resolve()
    if not project_dir.is_dir():
        print(f"ERROR: {project_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    stack, files = _load_inventory(project_dir)

    ts_stacks = {"typescript", "ts", "javascript", "js", "nextjs", "react", "next"}
    if stack.lower() in ts_stacks:
        graph = build_graph_typescript(project_dir, files)
    elif stack.lower() in {"python", "py"}:
        graph = build_graph_stub(project_dir, stack, files)
    elif stack.lower() in {"java", "kotlin", "jvm"}:
        graph = build_graph_stub(project_dir, stack, files)
    else:
        # Unknown stack — return empty graph with warning, do NOT guess
        print(f"WARNING: Dependency graph not implemented for stack '{stack}'.")
        print(f"  Byakugan will proceed with finding-level analysis only (no blast radius tracing).")
        graph = build_graph_stub(project_dir, stack, files)
        graph["warning"] = f"No dependency analysis available for '{stack}'. Impact analysis will be limited."

    # Write output
    out_dir = project_dir / "docs" / "audit" / "deep"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "dependency-graph.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(graph, fh, indent=2)

    stats = graph["stats"]
    print(
        f"Built dependency graph: {stats['total_files']} nodes, "
        f"{stats['total_edges']} edges"
    )
    print(f"Output: {out_path}")


if __name__ == "__main__":
    main()
