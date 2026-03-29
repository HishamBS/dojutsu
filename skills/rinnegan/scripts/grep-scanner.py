#!/usr/bin/env python3
"""Deterministic grep-based scanner. Finds ALL mechanical violations exhaustively.
Usage: grep-scanner.py <project_dir> <audit_dir>
Runs in seconds. Catches everything grep can catch. LLM scanners add intelligent findings on top."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grep_scanner_lib import (
    get_patterns_for_stack,
    load_inventory,
    scan_project,
    write_results,
    format_summary,
)

project_dir = sys.argv[1]
audit_dir = sys.argv[2]

source_files, stack, file_to_layer = load_inventory(audit_dir)
findings, counters = scan_project(project_dir, source_files, stack, file_to_layer)
write_results(audit_dir, findings, source_files)

patterns = get_patterns_for_stack(stack)
print(format_summary(findings, len(patterns), len(source_files), counters))
