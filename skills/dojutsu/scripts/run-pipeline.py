#!/usr/bin/env python3
"""Dojutsu pipeline orchestrator.
Run repeatedly. Each run: check state, delegate to active eye, output ACTION.
Usage: run-pipeline.py <project_dir>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_pipeline_lib import run_pipeline

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: run-pipeline.py <project_dir>")
        sys.exit(1)
    sys.exit(run_pipeline(sys.argv[1]))
