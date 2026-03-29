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
    if not os.path.exists(os.path.join(deep_dir, "impact-analysis.jsonl")):
        return "NEEDS_IMPACT_ANALYSIS"

    # Step 4: Narrative (LLM)
    if not os.path.exists(os.path.join(deep_dir, "narrative.md")):
        return "NEEDS_NARRATIVE"

    # Step 5: Scorecard (deterministic + LLM)
    if not os.path.exists(os.path.join(deep_dir, "scorecard.md")):
        return "NEEDS_SCORECARD"

    # Step 6: Deployment plan (LLM)
    if not os.path.exists(os.path.join(deep_dir, "deployment-plan.md")):
        return "NEEDS_DEPLOYMENT_PLAN"

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

        with open(clusters_path) as f:
            clusters = json.load(f)

        total_clusters = len(clusters["clusters"])
        print(f"\nCLUSTERS: {total_clusters}")
        print(f"\nACTION: Read {skill_dir}/impact-analysis-prompt.md then dispatch impact analysis agents.")
        print(f"  Each agent receives: cluster definition + dependency graph edges + findings JSONL")
        print(f"  Dispatch up to 5 agents in parallel. Each handles 5-10 clusters.")
        print(f"  Large clusters (>10 findings) get their own agent.")
        print(f"  After ALL agents complete, merge output to: {deep_dir}/impact-analysis.jsonl")
        print(f"  Then run this script again.")
        print()

        # List clusters for dispatch
        for cluster in clusters["clusters"][:20]:
            print(f"  CLUSTER: id={cluster['id']} type={cluster['type']} findings={cluster['finding_count']} severity={cluster.get('max_severity', 'UNKNOWN')}")
            print(f"    Files: {', '.join(cluster['files'][:5])}")

        if total_clusters > 20:
            print(f"  ... and {total_clusters - 20} more clusters")

        return 0

    if state == "NEEDS_NARRATIVE":
        print(f"\nACTION: Read {skill_dir}/narrative-generator-prompt.md then dispatch narrative generator.")
        print(f"  Agent reads: {deep_dir}/impact-analysis.jsonl + {deep_dir}/clusters.json + inventory")
        print(f"  Agent writes: {deep_dir}/narrative.md (2000-4000 lines, v5-quality)")
        print(f"  Then run this script again.")
        return 0

    if state == "NEEDS_SCORECARD":
        print(f"\nACTION: Read {skill_dir}/scorecard-generator-prompt.md then dispatch scorecard generator.")
        print(f"  Agent reads: findings.jsonl + clusters.json + inventory.json")
        print(f"  Agent writes: {deep_dir}/scorecard.md")
        print(f"  Then run this script again.")
        return 0

    if state == "NEEDS_DEPLOYMENT_PLAN":
        high_critical = _count_high_critical(project_dir)
        if high_critical == 0:
            # No HIGH/CRITICAL → write minimal deployment plan
            plan_path = os.path.join(deep_dir, "deployment-plan.md")
            with open(plan_path, "w") as f:
                f.write(f"# Deployment Plan\n\n")
                f.write(f"**Generated:** {_now_iso()}\n\n")
                f.write(f"No HIGH or CRITICAL findings detected. ")
                f.write(f"Standard deployment process applies.\n")
            print("AUTO: No HIGH/CRITICAL findings — minimal deployment plan written.")
            state = get_state(project_dir)
        else:
            print(f"\nHIGH/CRITICAL findings: {high_critical}")
            print(f"\nACTION: Read {skill_dir}/deployment-plan-prompt.md then dispatch deployment plan generator.")
            print(f"  Agent reads: impact-analysis.jsonl + clusters.json + narrative.md")
            print(f"  Agent writes: {deep_dir}/deployment-plan.md")
            print(f"  Then run this script again.")
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
