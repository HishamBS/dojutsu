"""Tests for deterministic DAG and rasengan-config generation."""
import json
import os
import sys
import tempfile

import pytest

SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from run_pipeline_lib import (
    RASENGAN_CONFIG_DEFAULTS,
    RASENGAN_CONFIG_METADATA_FIELDS,
    RASENGAN_CONFIG_REQUIRED_FIELDS,
    SPEC_PHASE_DAG,
    SPEC_PHASE_EDGES,
    SPEC_PHASE_NODES,
    generate_dag_and_config,
    generate_phase_dag,
    generate_rasengan_config,
)

# -- Helpers -------------------------------------------------------------------


def _make_audit_dir(tmp: str) -> str:
    """Create minimal audit_dir structure with data/ directory."""
    data_dir = os.path.join(tmp, "data")
    os.makedirs(data_dir, exist_ok=True)
    return tmp


def _write_findings(audit_dir: str, findings: list[dict]) -> None:
    """Write findings.jsonl into audit_dir/data/."""
    path = os.path.join(audit_dir, "data", "findings.jsonl")
    with open(path, "w") as fh:
        for f in findings:
            fh.write(json.dumps(f) + "\n")


def _write_config_json(audit_dir: str, config: dict) -> None:
    """Write config.json (aggregator output) into audit_dir/data/."""
    path = os.path.join(audit_dir, "data", "config.json")
    with open(path, "w") as fh:
        json.dump(config, fh)


def _write_inventory_json(audit_dir: str, inventory: dict) -> None:
    """Write inventory.json into audit_dir/data/."""
    path = os.path.join(audit_dir, "data", "inventory.json")
    with open(path, "w") as fh:
        json.dump(inventory, fh)


def _make_finding(phase: int, finding_id: str = "TST-001") -> dict:
    return {
        "id": finding_id,
        "rule": "R14",
        "severity": "HIGH",
        "category": "build",
        "file": "src/foo.py",
        "line": 10,
        "snippet": "import os",
        "current_code": "import os",
        "description": "Test finding",
        "explanation": "This is a test finding for DAG and config tests.",
        "search_pattern": "import os",
        "phase": phase,
        "effort": "low",
        "layer": "utils",
        "scanner": "test-scanner",
        "target_code": "import pathlib",
        "fix_plan": None,
        "completed_at": None,
        "resolution": None,
        "actual_line": None,
        "notes": "",
    }


# -- DAG Spec Constant Tests --------------------------------------------------


class TestSpecPhaseDAGConstants:
    """Verify the hardcoded DAG constants match the spec exactly."""

    def test_node_count(self) -> None:
        assert len(SPEC_PHASE_NODES) == 11

    def test_node_ids_are_sequential(self) -> None:
        ids = [n["id"] for n in SPEC_PHASE_NODES]
        assert ids == list(range(11))

    def test_edge_count(self) -> None:
        assert len(SPEC_PHASE_EDGES) == 13

    def test_phase_0_branches_to_two_children(self) -> None:
        """Phase 0 must branch to at least 2 children (not linear)."""
        children_of_0 = [e["to"] for e in SPEC_PHASE_EDGES if e["from"] == 0]
        assert len(children_of_0) >= 2
        assert 1 in children_of_0
        assert 2 in children_of_0

    def test_phase_3_has_two_parents(self) -> None:
        """Phase 3 depends on both Phase 1 and Phase 2."""
        parents_of_3 = [e["from"] for e in SPEC_PHASE_EDGES if e["to"] == 3]
        assert sorted(parents_of_3) == [1, 2]

    def test_phase_3_branches_to_4_and_7(self) -> None:
        children_of_3 = [e["to"] for e in SPEC_PHASE_EDGES if e["from"] == 3]
        assert sorted(children_of_3) == [4, 7]

    def test_phase_4_branches_to_5_and_6(self) -> None:
        children_of_4 = [e["to"] for e in SPEC_PHASE_EDGES if e["from"] == 4]
        assert sorted(children_of_4) == [5, 6]

    def test_phases_5_and_6_converge_to_8(self) -> None:
        parents_of_8 = [e["from"] for e in SPEC_PHASE_EDGES if e["to"] == 8]
        assert sorted(parents_of_8) == [5, 6]

    def test_phases_7_and_8_converge_to_9(self) -> None:
        parents_of_9 = [e["from"] for e in SPEC_PHASE_EDGES if e["to"] == 9]
        assert sorted(parents_of_9) == [7, 8]

    def test_phase_10_is_terminal(self) -> None:
        children_of_10 = [e["to"] for e in SPEC_PHASE_EDGES if e["from"] == 10]
        assert children_of_10 == []

    def test_dag_edges_match_spec_exactly(self) -> None:
        """Full edge list from the spec (output-templates.md)."""
        expected = [
            {"from": 0, "to": 1},
            {"from": 0, "to": 2},
            {"from": 1, "to": 3},
            {"from": 2, "to": 3},
            {"from": 3, "to": 4},
            {"from": 3, "to": 7},
            {"from": 4, "to": 5},
            {"from": 4, "to": 6},
            {"from": 5, "to": 8},
            {"from": 6, "to": 8},
            {"from": 7, "to": 9},
            {"from": 8, "to": 9},
            {"from": 9, "to": 10},
        ]
        assert SPEC_PHASE_EDGES == expected

    def test_dag_is_not_linear_chain(self) -> None:
        """Verify the DAG is a tree/diamond, not a simple linear chain."""
        # A linear chain of 11 nodes would have 10 edges each with unique from/to
        from_counts: dict[int, int] = {}
        for e in SPEC_PHASE_EDGES:
            from_counts[e["from"]] = from_counts.get(e["from"], 0) + 1
        # At least one node must have >1 outgoing edge (branching)
        max_out = max(from_counts.values())
        assert max_out >= 2, "DAG must have branching, not be a linear chain"

    def test_node_names_match_spec(self) -> None:
        expected_names = [
            "Foundation", "Security", "Typing", "SSOT/DRY",
            "Architecture", "Clean Code", "Performance",
            "Data Integrity", "Refactoring", "Verification", "Documentation",
        ]
        actual_names = [n["name"] for n in SPEC_PHASE_NODES]
        assert actual_names == expected_names


# -- DAG Generation Tests ------------------------------------------------------


class TestGeneratePhaseDag:
    """Test the generate_phase_dag function."""

    def test_writes_dag_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            generate_phase_dag(audit_dir)
            dag_path = os.path.join(audit_dir, "data", "phase-dag.json")
            assert os.path.isfile(dag_path)

    def test_dag_structure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            dag = generate_phase_dag(audit_dir)
            assert "nodes" in dag
            assert "edges" in dag
            assert len(dag["nodes"]) == 11
            assert len(dag["edges"]) == 13

    def test_dag_edges_match_spec(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            dag = generate_phase_dag(audit_dir)
            # Strip finding_count from edges comparison
            edges_only = [{"from": e["from"], "to": e["to"]} for e in dag["edges"]]
            assert edges_only == SPEC_PHASE_EDGES

    def test_finding_counts_annotated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            findings = [
                _make_finding(0, "BLD-001"),
                _make_finding(0, "BLD-002"),
                _make_finding(1, "SEC-001"),
                _make_finding(5, "CLN-001"),
            ]
            _write_findings(audit_dir, findings)
            dag = generate_phase_dag(audit_dir)
            counts = {n["id"]: n["finding_count"] for n in dag["nodes"]}
            assert counts[0] == 2
            assert counts[1] == 1
            assert counts[5] == 1
            assert counts[10] == 0

    def test_no_findings_file_gives_zero_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            dag = generate_phase_dag(audit_dir)
            for node in dag["nodes"]:
                assert node["finding_count"] == 0

    def test_dag_round_trips_through_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            generate_phase_dag(audit_dir)
            dag_path = os.path.join(audit_dir, "data", "phase-dag.json")
            with open(dag_path) as fh:
                loaded = json.load(fh)
            assert len(loaded["nodes"]) == 11
            assert len(loaded["edges"]) == 13

    def test_phase_0_branches_in_generated_dag(self) -> None:
        """Generated DAG must also show branching from phase 0."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            dag = generate_phase_dag(audit_dir)
            children_of_0 = [e["to"] for e in dag["edges"] if e["from"] == 0]
            assert len(children_of_0) >= 2


# -- Config Generation Tests ---------------------------------------------------


class TestGenerateRasenganConfig:
    """Test the generate_rasengan_config function."""

    def test_writes_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            generate_rasengan_config(audit_dir, "/project")
            cfg_path = os.path.join(audit_dir, "data", "rasengan-config.json")
            assert os.path.isfile(cfg_path)

    def test_config_has_all_8_designed_fields(self) -> None:
        """Spec requires exactly these 8 fields from output-templates.md section 5."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/project")
            for field in RASENGAN_CONFIG_REQUIRED_FIELDS:
                assert field in config, f"Missing required config field: {field}"

    def test_config_preserves_project_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/my/project")
            assert config["project_dir"] == "/my/project"

    def test_config_preserves_audit_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/project")
            assert config["audit_dir"] == audit_dir

    def test_config_reads_stack_from_config_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_config_json(audit_dir, {"stack": "python", "framework": "fastapi"})
            config = generate_rasengan_config(audit_dir, "/project")
            assert config["stack"] == "python"
            assert config["framework"] == "fastapi"

    def test_config_reads_stack_from_inventory_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory_json(audit_dir, {
                "stack": "typescript",
                "framework": "next",
                "total_files": 50,
                "total_loc": 5000,
                "layers": {},
                "files": [],
                "root": "myapp",
            })
            config = generate_rasengan_config(audit_dir, "/project")
            assert config["stack"] == "typescript"
            assert config["framework"] == "next"

    def test_config_defaults_to_unknown_without_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/project")
            assert config["stack"] == "unknown"
            assert config["framework"] == "unknown"

    def test_config_default_values_match_spec(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/project")
            assert config["commit_strategy"] == "per-phase"
            assert config["session_bridging"] == "json"
            assert config["stale_fix_mode"] == "adapt"
            assert config["mini_scan_after_phase"] is True
            assert config["sharingan_after_phase"] is False
            assert config["sharingan_after_all"] is True
            assert config["max_retries_per_phase"] == 2
            assert config["max_retries_per_task"] == 1

    def test_config_has_metadata_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            config = generate_rasengan_config(audit_dir, "/project")
            for field in RASENGAN_CONFIG_METADATA_FIELDS:
                assert field in config, f"Missing metadata field: {field}"

    def test_config_round_trips_through_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            generate_rasengan_config(audit_dir, "/project")
            cfg_path = os.path.join(audit_dir, "data", "rasengan-config.json")
            with open(cfg_path) as fh:
                loaded = json.load(fh)
            for field in RASENGAN_CONFIG_REQUIRED_FIELDS:
                assert field in loaded


# -- Combined Generation Tests -------------------------------------------------


class TestGenerateDagAndConfig:
    """Test the combined generate_dag_and_config function."""

    def test_returns_both(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            dag, config = generate_dag_and_config(audit_dir, "/project")
            assert "nodes" in dag
            assert "edges" in dag
            assert "commit_strategy" in config
            assert "project_dir" in config

    def test_both_files_written(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            generate_dag_and_config(audit_dir, "/project")
            assert os.path.isfile(os.path.join(audit_dir, "data", "phase-dag.json"))
            assert os.path.isfile(os.path.join(audit_dir, "data", "rasengan-config.json"))

    def test_idempotent_double_call(self) -> None:
        """Calling twice produces identical output."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_findings(audit_dir, [_make_finding(0), _make_finding(3)])
            dag1, cfg1 = generate_dag_and_config(audit_dir, "/project")
            dag2, cfg2 = generate_dag_and_config(audit_dir, "/project")
            assert dag1 == dag2
            assert cfg1 == cfg2

    def test_config_json_preference_over_inventory(self) -> None:
        """config.json (aggregator output) takes priority over inventory for stack/framework."""
        with tempfile.TemporaryDirectory() as tmp:
            audit_dir = _make_audit_dir(tmp)
            _write_inventory_json(audit_dir, {
                "stack": "python",
                "framework": "flask",
                "total_files": 10,
                "total_loc": 1000,
                "layers": {},
                "files": [],
                "root": "app",
            })
            _write_config_json(audit_dir, {
                "stack": "python",
                "framework": "fastapi",
            })
            _, config = generate_dag_and_config(audit_dir, "/project")
            assert config["framework"] == "fastapi"
