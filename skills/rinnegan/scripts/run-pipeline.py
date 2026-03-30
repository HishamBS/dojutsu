#!/usr/bin/env python3
"""Rinnegan pipeline state machine.
Run repeatedly. Each run: check disk state, auto-advance deterministic steps, output ONE action for LLM.
Usage: run-pipeline.py <project_dir>"""
import json, os, sys, subprocess, glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_pipeline_lib import generate_dag_and_config, validate_null_fix_coverage

project_dir = sys.argv[1]
audit_dir = os.path.join(project_dir, "docs", "audit")
skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def file_exists(path):
    return os.path.isfile(os.path.join(audit_dir, path))

def dir_exists(path):
    return os.path.isdir(os.path.join(audit_dir, path))

def count_lines(path):
    try:
        with open(os.path.join(audit_dir, path)) as f:
            return sum(1 for _ in f)
    except:
        return 0

def run_script(name, *args):
    script = os.path.join(skill_dir, "scripts", name)
    result = subprocess.run(["python3", script] + list(args), capture_output=True, text=True)
    print(result.stdout.strip())
    if result.returncode != 0 and result.stderr.strip():
        print(f"SCRIPT_ERROR: {result.stderr.strip()}")
    return result.returncode

def get_state():
    # Check for quality gates before anything else
    pre_commit = os.path.join(project_dir, ".pre-commit-config.yaml")
    if not os.path.exists(pre_commit):
        return "NEEDS_QUALITY_GATES"
    if not file_exists("data/inventory.json"):
        return "NEEDS_INVENTORY"
    if not file_exists("data/scan-plan.json"):
        return "NEEDS_SCAN_PLAN"
    plan = json.load(open(os.path.join(audit_dir, "data/scan-plan.json")))
    pending = sum(1 for b in plan["batches"] if b["status"] == "pending")
    if pending > 0:
        return "NEEDS_SCANNING"
    if not file_exists("data/findings.jsonl") or count_lines("data/findings.jsonl") == 0:
        return "NEEDS_AGGREGATION"
    enriched_count = len(glob.glob(os.path.join(audit_dir, "data/enriched/*.jsonl")))
    if enriched_count == 0:
        return "NEEDS_ENRICHMENT"
    if not file_exists("data/phase-dag.json"):
        return "NEEDS_PHASES"
    if not file_exists("master-audit.md"):
        return "NEEDS_GENERATION"
    if count_lines("master-audit.md") < 300:
        return "NEEDS_GENERATION"
    # Check layer docs exist and meet minimum total
    layer_docs = glob.glob(os.path.join(audit_dir, "layers/*.md"))
    if not layer_docs:
        return "NEEDS_GENERATION"
    inv = json.load(open(os.path.join(audit_dir, "data/inventory.json")))
    layer_total = sum(count_lines(os.path.relpath(f, audit_dir)) for f in layer_docs)
    min_layer_total = inv["total_loc"] * 20 // 1000
    if layer_total < min_layer_total:
        return "NEEDS_GENERATION"
    # Check task files exist
    if not glob.glob(os.path.join(audit_dir, "data/tasks/phase-*-tasks.json")):
        return "NEEDS_PHASES"
    return "COMPLETE"

# Auto-advance deterministic steps
state = get_state()

if state == "NEEDS_QUALITY_GATES":
    print(f"\nSTATE: NEEDS_QUALITY_GATES")
    print(f"\nQuality gate enforcement is required before auditing.")
    print(f"No .pre-commit-config.yaml found in {project_dir}")
    print(f"\nACTION: Run /setup-quality-gates on this project first.")
    print(f"  This sets up pre-commit hooks, linting, formatting, and type-checking")
    print(f"  for the detected stack. Once complete, re-run /rinnegan.")
    sys.exit(0)

if state == "NEEDS_INVENTORY":
    print("AUTO: Creating inventory + directories...")
    run_script("create-inventory.py", project_dir, audit_dir)
    state = get_state()

if state == "NEEDS_SCAN_PLAN":
    print("AUTO: Creating scan plan...")
    run_script("create-scan-plan.py", audit_dir)
    # Also run exhaustive grep scanner (deterministic, finds ALL mechanical violations)
    print("\nAUTO: Running exhaustive grep scanner...")
    run_script("grep-scanner.py", project_dir, audit_dir)
    state = get_state()

# Output state + action
print(f"\nSTATE: {state}")
print(f"AUDIT_DIR: {audit_dir}")
print(f"SKILL_DIR: {skill_dir}")
print(f"PROJECT_DIR: {project_dir}")

if state == "NEEDS_SCANNING":
    plan = json.load(open(os.path.join(audit_dir, "data/scan-plan.json")))
    pending = [b for b in plan["batches"] if b["status"] == "pending"]
    complete = sum(1 for b in plan["batches"] if b["status"] == "complete")
    inv = json.load(open(os.path.join(audit_dir, "data/inventory.json")))

    print(f"\nSCAN_PROGRESS: {complete}/{plan['total_batches']} complete, {len(pending)} pending")
    print(f"STACK: {inv.get('stack', 'unknown')}/{inv.get('framework', 'unknown')}")
    print(f"\nACTION: Read {skill_dir}/scanner-prompt.md then dispatch up to 5 scanner Agents.")
    print(f"  MODEL: haiku")
    print(f"  ROLE: dojutsu-scanner (if agent-mux configured)")
    print(f"  NOTE: Scanners do pattern detection — cheap models handle this well. Do NOT use opus.")
    print(f"Each scanner Agent prompt must include: scanner-prompt.md content + file list + stack + layer + output path.")
    print(f"After ALL dispatched scanners complete, update scan-plan.json: set each batch status to 'complete'.")
    print(f"Then run this script again.\n")

    for b in pending[:5]:
        output_path = os.path.join(audit_dir, b["output_file"])
        print(f"SCANNER_BATCH: id={b['id']} layer={b['layer']} output={output_path} files={len(b['files'])}")
        print(f"  FILES: {' '.join(b['files'])}")

elif state == "NEEDS_AGGREGATION":
    scanner_files = glob.glob(os.path.join(audit_dir, "data/scanner-output/*.jsonl"))
    total_findings = sum(sum(1 for _ in open(f)) for f in scanner_files)

    print(f"\nSCANNER_OUTPUT: {len(scanner_files)} files, {total_findings} total findings")
    print(f"\nACTION: Read {skill_dir}/aggregator-prompt.md then dispatch 1 Aggregator Agent.")
    print(f"  MODEL: haiku")
    print(f"  ROLE: dojutsu-scanner (if agent-mux configured)")
    print(f"Include in prompt: aggregator-prompt.md content + these paths:")
    print(f"  SCANNER_OUTPUT_DIR: {audit_dir}/data/scanner-output/")
    print(f"  INVENTORY_PATH: {audit_dir}/data/inventory.json")
    print(f"  AUDIT_DATA_DIR: {audit_dir}/data/")
    print(f"Aggregator reads from disk, writes findings.jsonl + config.json.")
    print(f"After complete, run this script again.")

elif state == "NEEDS_ENRICHMENT":
    findings = [json.loads(l) for l in open(os.path.join(audit_dir, "data/findings.jsonl"))]
    from collections import Counter
    layers = Counter(f.get("layer", "unknown") for f in findings)
    os.makedirs(os.path.join(audit_dir, "data/enriched"), exist_ok=True)

    print(f"\nFINDINGS: {len(findings)} across {len(layers)} layers")
    print(f"\nACTION: Read {skill_dir}/fix-enricher-instructions.md then dispatch 1 Fix Enricher Agent per layer.")
    print(f"  MODEL: sonnet")
    print(f"  ROLE: dojutsu-enricher (if agent-mux configured)")
    print(f"  NOTE: Enrichers must understand code well enough to write correct fixes. Use sonnet, not haiku.")
    print(f"Each enricher reads findings.jsonl, filters for its layer, adds target_code/fix_plan, writes enriched/.")
    for name, count in layers.most_common():
        print(f"  LAYER: {name} ({count} findings) -> {audit_dir}/data/enriched/{name}.jsonl")
    print(f"\nAfter ALL enrichers complete, run: python3 {skill_dir}/scripts/merge-enriched.py {audit_dir}")
    print(f"Then run this script again.")

elif state == "NEEDS_PHASES":
    # Null-fix validation gate: check enrichment quality before proceeding
    nfv = validate_null_fix_coverage(audit_dir)
    if nfv["triggered"]:
        print(f"\nWARNING: NULL_FIX_VALIDATION_FAILED")
        print(f"  {nfv['null_fix_count']}/{nfv['non_review_count']} non-REVIEW findings "
              f"({nfv['percent']:.1f}%) have BOTH target_code and fix_plan null.")
        print(f"  Threshold: >5%. Per finding-schema.md: both null on non-REVIEW = scanner failure.")
        print(f"  SUGGESTED ACTION: Re-dispatch enrichers for layers with high null-fix rates.")
        print(f"  To inspect: grep -c '\"target_code\":null' {audit_dir}/data/findings.jsonl")
        print(f"  Fix the enrichment before proceeding to phase generation.\n")

    # Deterministic generation: DAG and config are spec-fixed, never LLM-generated
    dag, rasengan_cfg = generate_dag_and_config(audit_dir, project_dir)
    print(f"\nAUTO: Wrote phase-dag.json ({len(dag['edges'])} edges, {len(dag['nodes'])} nodes)")
    print(f"AUTO: Wrote rasengan-config.json ({len(rasengan_cfg)} fields)")

    findings_count = count_lines("data/findings.jsonl")
    print(f"\nFINDINGS: {findings_count}")
    print(f"\nACTION: Create task files for each phase.")
    print(f"  Read {skill_dir}/finding-schema.md for the task file schema.")
    print(f"  Create {audit_dir}/data/tasks/phase-N-tasks.json for each phase with findings.")
    print(f"  phase-dag.json and rasengan-config.json are already written (deterministic).")
    print(f"Then run this script again.")

elif state == "NEEDS_GENERATION":
    inv = json.load(open(os.path.join(audit_dir, "data/inventory.json")))
    findings_count = count_lines("data/findings.jsonl")

    print(f"\nFINDINGS: {findings_count}, LAYERS: {len(inv['layers'])}, LOC: {inv['total_loc']}")
    print(f"\nACTION: Read generator prompts then dispatch generators:")
    print(f"  MODEL for layer generators: sonnet")
    print(f"  MODEL for master-hub generator: opus (ONE dispatch — premium writing)")
    print(f"  MODEL for cross-cutting generator: sonnet")
    print(f"  ROLES: dojutsu-enricher (layers/cross-cutting), dojutsu-narrator (master-hub)")
    print(f"  {skill_dir}/layer-generator-prompt.md (per layer)")
    print(f"  {skill_dir}/master-hub-generator-prompt.md (1 hub, 300-500 lines)")
    print(f"  {skill_dir}/cross-cutting-generator-prompt.md (1 cross-cutting)")
    print(f"  {skill_dir}/output-templates.md (for phase/progress/config templates)")
    print(f"  {skill_dir}/finding-schema.md (for JSON Generator task transformation)")
    print(f"\nGenerators read findings.jsonl from disk. Pass AUDIT_DIR + layer name + min lines.")
    for name, data in sorted(inv["layers"].items(), key=lambda x: -x[1]["loc"]):
        min_lines = max(10, data["loc"] * 20 // 1000)
        print(f"  LAYER: {name} ({data['loc']} LOC, {len(data['files'])} files, min {min_lines} lines)")
    print(f"\nAlso create: progress.md, agent-instructions.md")
    print(f"After complete, run this script again.")

elif state == "COMPLETE":
    findings_count = count_lines("data/findings.jsonl")
    master_lines = count_lines("master-audit.md")
    layer_lines = sum(count_lines(os.path.relpath(f, audit_dir))
                      for f in glob.glob(os.path.join(audit_dir, "layers/*.md")))
    findings = [json.loads(l) for l in open(os.path.join(audit_dir, "data/findings.jsonl"))]
    has_fix = sum(1 for f in findings if f.get("target_code") is not None or f.get("fix_plan"))

    print(f"\nPIPELINE_COMPLETE")
    print(f"  Findings: {findings_count}")
    print(f"  Fix coverage: {has_fix}/{findings_count} ({has_fix*100//max(findings_count,1)}%)")
    print(f"  master-audit.md: {master_lines} lines")
    print(f"  Layer docs: {layer_lines} lines")
    print(f"\nACTION: Run verification scripts:")
    print(f"  {skill_dir}/verify-output.sh {audit_dir}")
    print(f"  {skill_dir}/verify-snippets.sh {audit_dir} {project_dir}")
    print(f"  {skill_dir}/verify-coverage.sh {audit_dir} {project_dir}")
