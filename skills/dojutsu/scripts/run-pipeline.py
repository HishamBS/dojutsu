#!/usr/bin/env python3
"""Dojutsu pipeline orchestrator.
Usage:
  run-pipeline.py <project_dir>                    # audit only (default)
  run-pipeline.py <project_dir> --fix              # audit + fix (interactive)
  run-pipeline.py <project_dir> --fix --auto       # fully autonomous
  run-pipeline.py <project_dir> --fix --phases 0,1 # fix specific phases
  run-pipeline.py <project_dir> --resume           # resume from saved state
  run-pipeline.py <project_dir> --status           # show state
  run-pipeline.py <project_dir> --report           # regenerate reports
  run-pipeline.py <project_dir> --clean            # wipe audit data
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_pipeline_lib import run_pipeline


def parse_args():
    p = argparse.ArgumentParser(prog="dojutsu", description="Audit, analyze, fix, verify.")
    p.add_argument("project_dir", help="Project directory")
    info = p.add_mutually_exclusive_group()
    info.add_argument("--status", action="store_true", help="Show state without running")
    info.add_argument("--report", action="store_true", help="Regenerate reports")
    info.add_argument("--clean", action="store_true", help="Remove all audit data")
    p.add_argument("--fix", action="store_true", help="Enable code fixing (rasengan+sharingan)")
    p.add_argument("--phases", type=str, default=None, help="Comma-separated phases to fix (requires --fix)")
    approval = p.add_mutually_exclusive_group()
    approval.add_argument("--auto", action="store_true", help="No approval gates (requires --fix)")
    approval.add_argument("--interactive", action="store_true", help="Approve per phase (default with --fix)")
    p.add_argument("--resume", action="store_true", help="Resume from saved state")
    args = p.parse_args()
    if args.phases and not args.fix:
        p.error("--phases requires --fix")
    if args.auto and not args.fix:
        p.error("--auto requires --fix")
    return args


if __name__ == "__main__":
    args = parse_args()
    phases = [int(x.strip()) for x in args.phases.split(",")] if args.phases else None
    flags = {
        "mode": "fix" if args.fix else "audit",
        "phases": phases,
        "approval": "auto" if args.auto else "interactive",
        "resume": args.resume,
        "status": args.status,
        "report": args.report,
        "clean": args.clean,
    }
    sys.exit(run_pipeline(os.path.abspath(args.project_dir), flags=flags))
