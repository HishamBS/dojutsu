"""Byakugan pipeline state machine — deep analysis engine.

Builds dependency graph, clusters findings, dispatches impact analysis agents,
generates narrative, scorecard, and deployment plan.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

# Token budget tracking (graceful fallback if dojutsu not installed)
import sys as _sys
_dojutsu_scripts = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'dojutsu', 'scripts')
if os.path.isdir(_dojutsu_scripts):
    _sys.path.insert(0, os.path.realpath(_dojutsu_scripts))
try:
    from dojutsu_state import log_dispatch
    from work_orders import write_impact_work_orders
except ImportError:
    def log_dispatch(*a, **kw): pass
    def write_impact_work_orders(*a, **kw): return 0

try:
    from merge_impact_analysis import impact_output_status, merge_impact_analysis_outputs
except ImportError:
    def impact_output_status(_project_dir: str) -> dict:
        return {
            "parts_dir": "",
            "expected_clusters": [],
            "completed_clusters": [],
            "missing_clusters": [],
            "invalid_parts": [],
            "complete": False,
            "merge_needed": False,
        }

    def merge_impact_analysis_outputs(_project_dir: str) -> dict:
        raise ValueError("merge_impact_analysis unavailable")

_rinnegan_scripts = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "rinnegan", "scripts"
)
if os.path.isdir(_rinnegan_scripts):
    if _rinnegan_scripts not in sys.path:
        sys.path.insert(0, os.path.realpath(_rinnegan_scripts))
try:
    from bundle_renderer import render_bundle
    from report_contract import validate_publication_contract
except ImportError:
    def render_bundle(_audit_dir: str, _stage: str, check: bool = False) -> dict:
        return {"written": [], "mismatches": [], "count": 0}

    def validate_publication_contract(_audit_dir: str, stage: str = "byakugan") -> dict:
        return {"ok": False, "stage": stage, "errors": ["report_contract unavailable"]}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_state(project_dir: str) -> str:
    """Determine current pipeline state from disk artifacts."""
    audit_dir = os.path.join(project_dir, "docs/audit")
    deep_dir = os.path.join(audit_dir, "deep")
    data_dir = os.path.join(audit_dir, "data")

    # Prerequisite: rinnegan must be complete
    if not os.path.exists(os.path.join(data_dir, "findings.jsonl")):
        return "NEEDS_RINNEGAN"

    # Step 1: Dependency graph (deterministic)
    if not os.path.exists(os.path.join(deep_dir, "dependency-graph.json")):
        return "NEEDS_DEPENDENCY_GRAPH"

    # Step 2: Clustering (deterministic)
    if not os.path.exists(os.path.join(deep_dir, "clusters.json")):
        return "NEEDS_CLUSTERING"

    # Step 3: Impact analysis (LLM agents)
    impact_status = impact_output_status(project_dir)
    if impact_status.get("merge_needed", False):
        return "NEEDS_IMPACT_MERGE"
    if not os.path.exists(os.path.join(deep_dir, "impact-analysis.jsonl")):
        if impact_status["complete"]:
            return "NEEDS_IMPACT_MERGE"
        return "NEEDS_IMPACT_ANALYSIS"

    # Step 4: Deterministic publication bundle (compiled from SSOT)
    deterministic_outputs = [
        "narrative.md",
        "scorecard.md",
        "deployment-plan.md",
        "executive-brief.md",
    ]
    if not all(os.path.exists(os.path.join(deep_dir, name)) for name in deterministic_outputs):
        return "NEEDS_REPORT_RENDER"

    publication = validate_publication_contract(audit_dir, stage="byakugan")
    if not publication["ok"]:
        return "NEEDS_REPORT_RENDER"

    return "COMPLETE"


def _run_deterministic_script(script_name: str, project_dir: str) -> int:
    """Run a deterministic script and print its output."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    script_path = os.path.join(script_dir, script_name)

    if not os.path.exists(script_path):
        print(f"ERROR: Script not found: {script_path}")
        return 1

    result = subprocess.run(
        ["python3", script_path, project_dir],
        capture_output=True, text=True,
    )
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        print(f"SCRIPT_ERROR: {result.stderr.strip()}")
        return 1
    return 0


def _count_high_critical(project_dir: str) -> int:
    """Count HIGH and CRITICAL findings."""
    findings_path = os.path.join(project_dir, "docs/audit/data/findings.jsonl")
    count = 0
    if os.path.exists(findings_path):
        with open(findings_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                finding = json.loads(line)
                if finding.get("severity") in ("HIGH", "CRITICAL"):
                    count += 1
    return count


def run_pipeline(project_dir: str) -> int:
    """Main entry point. Check state, auto-advance deterministic steps, emit actions."""
    project_dir = os.path.abspath(project_dir)
    audit_dir = os.path.join(project_dir, "docs/audit")
    deep_dir = os.path.join(audit_dir, "deep")
    skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    state = get_state(project_dir)

    # Auto-advance: deterministic steps run inline without LLM
    if state == "NEEDS_DEPENDENCY_GRAPH":
        print("AUTO: Building dependency graph...")
        os.makedirs(deep_dir, exist_ok=True)
        rc = _run_deterministic_script("build_dependency_graph.py", project_dir)
        if rc != 0:
            return rc
        state = get_state(project_dir)

    if state == "NEEDS_CLUSTERING":
        print("AUTO: Clustering findings...")
        rc = _run_deterministic_script("cluster_findings.py", project_dir)
        if rc != 0:
            return rc
        state = get_state(project_dir)

    if state == "NEEDS_IMPACT_MERGE":
        print("AUTO: Merging impact-analysis parts...")
        try:
            manifest = merge_impact_analysis_outputs(project_dir)
        except ValueError as exc:
            print(f"ERROR: {exc}")
            return 1
        print(
            "AUTO: Wrote impact-analysis.jsonl "
            f"({manifest['merged_findings']} findings from {len(manifest['completed_clusters'])} clusters)"
        )
        state = get_state(project_dir)

    if state == "NEEDS_REPORT_RENDER":
        print("AUTO: Rendering deterministic deep-analysis bundle...")
        render_bundle(audit_dir, "byakugan", check=False)
        publication = validate_publication_contract(audit_dir, stage="byakugan")
        if not publication["ok"]:
            print("ERROR: byakugan publication contract is invalid")
            for error in publication["errors"]:
                print(f"  - {error}")
            return 1
        print("AUTO: Deterministic deep-analysis bundle validated.")
        state = get_state(project_dir)

    # Output state + action
    print(f"\nSTATE: {state}")
    print(f"AUDIT_DIR: {audit_dir}")
    print(f"DEEP_DIR: {deep_dir}")
    print(f"SKILL_DIR: {skill_dir}")
    print(f"PROJECT_DIR: {project_dir}")

    if state == "NEEDS_RINNEGAN":
        print("\nACTION: Run rinnegan first to produce findings.")
        print(f"  Run: python3 $SKILL_DIR/../rinnegan/scripts/run-pipeline.py {project_dir}")
        print("  (Or invoke /rinnegan if running inside a coding agent.)")
        print("  Repeat until PIPELINE_COMPLETE, then run this script again.")
        return 0

    if state == "NEEDS_IMPACT_ANALYSIS":
        clusters_path = os.path.join(deep_dir, "clusters.json")
        dep_graph_path = os.path.join(deep_dir, "dependency-graph.json")
        findings_path = os.path.join(audit_dir, "data/findings.jsonl")
        impact_status = impact_output_status(project_dir)
        parts_dir = impact_status["parts_dir"]
        os.makedirs(parts_dir, exist_ok=True)

        with open(clusters_path) as f:
            clusters = json.load(f)

        total_clusters = len(clusters["clusters"])
        work_order_count = write_impact_work_orders(
            audit_dir,
            clusters["clusters"],
            set(impact_status["completed_clusters"]),
        )
        print(f"\nCLUSTERS: {total_clusters}")
        print(f"WORK_ORDERS: {work_order_count} impact-analysis requests on disk")
        log_dispatch(project_dir, task="impact_analysis", tokens=30000 * min(total_clusters // 5 + 1, 5), model="sonnet")

        print(f"\nACTION: Read {skill_dir}/impact-analysis-prompt.md then dispatch impact analysis agents.")
        print(f"  MODEL: sonnet")
        print(f"  ROLE: dojutsu-analyst (if agent-mux configured)")
        print(f"  Each agent receives: cluster definition + dependency graph edges + findings JSONL")
        print(f"  Dispatch up to 5 agents in parallel. Each handles one cluster JSON output file.")
        print(f"  Large clusters (>10 findings) still get their own agent.")
        print(f"  Write each result to: {parts_dir}/<CLUSTER_ID>.json")
        print(f"  Re-run this script after each batch. It auto-merges when all cluster files exist.")
        if impact_status["completed_clusters"]:
            print(
                f"  Resumption: {len(impact_status['completed_clusters'])}/{len(impact_status['expected_clusters'])} "
                "cluster files already on disk."
            )
        if impact_status["invalid_parts"]:
            print(f"  INVALID PARTS: {', '.join(impact_status['invalid_parts'])}")
        if impact_status["missing_clusters"]:
            print(f"  PENDING CLUSTERS: {', '.join(impact_status['missing_clusters'][:10])}")
        print()

        # List clusters for dispatch
        for cluster in clusters["clusters"][:20]:
            print(f"  CLUSTER: id={cluster['id']} type={cluster['type']} findings={cluster['finding_count']} severity={cluster.get('max_severity', 'UNKNOWN')}")
            print(f"    Files: {', '.join(cluster['files'][:5])}")

        if total_clusters > 20:
            print(f"  ... and {total_clusters - 20} more clusters")

        return 0

    if state == "COMPLETE":
        # Count artifacts
        impact_count = 0
        impact_path = os.path.join(deep_dir, "impact-analysis.jsonl")
        if os.path.exists(impact_path):
            with open(impact_path) as f:
                impact_count = sum(1 for _ in f)

        narrative_lines = 0
        narrative_path = os.path.join(deep_dir, "narrative.md")
        if os.path.exists(narrative_path):
            with open(narrative_path) as f:
                narrative_lines = sum(1 for _ in f)

        print(f"\nBYAKUGAN_COMPLETE")
        print(f"  Dependency graph: {deep_dir}/dependency-graph.json")
        print(f"  Clusters: {deep_dir}/clusters.json")
        print(f"  Impact analyses: {impact_count} entries")
        print(f"  Narrative: {narrative_lines} lines")
        print(f"  Scorecard: {deep_dir}/scorecard.md")
        print(f"  Deployment plan: {deep_dir}/deployment-plan.md")

    return 0
