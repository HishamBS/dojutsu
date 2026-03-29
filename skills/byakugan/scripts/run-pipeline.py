#!/usr/bin/env python3
"""Byakugan pipeline state machine.
Run repeatedly. Each run: check disk state, output ONE action for LLM.
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
