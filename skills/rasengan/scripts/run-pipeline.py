#!/usr/bin/env python3
"""Rasengan pipeline state machine.
Run repeatedly. Each run: check disk state, output ONE action for LLM.
Usage: run-pipeline.py <project_dir>"""
import sys

from run_pipeline_lib import run_pipeline

if __name__ == "__main__":
    exit_code = run_pipeline(sys.argv[1])
    sys.exit(exit_code)
