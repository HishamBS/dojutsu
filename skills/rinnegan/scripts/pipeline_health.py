"""Generate pipeline health report after tool scanning.

Writes docs/audit/data/pipeline-health.json with structured metrics
about tool execution results, finding counts, and project size.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tool_runner import ToolResult


def write_health_report(
    audit_dir: str,
    tool_results: list[ToolResult],
    project_dir: str,
) -> dict[str, object]:
    """Write pipeline-health.json and return the report dict.

    Parameters
    ----------
    audit_dir:
        Path to the docs/audit directory (e.g. <project>/docs/audit).
    tool_results:
        List of ToolResult dataclass instances from run_tool_safe calls.
    project_dir:
        Root directory of the project being audited.

    Returns
    -------
    The health report dict that was written to disk.
    """
    succeeded = sum(1 for r in tool_results if r.status == "success")
    skipped = sum(1 for r in tool_results if r.status == "skipped")
    failed = sum(1 for r in tool_results if r.status == "failed")
    timed_out = sum(1 for r in tool_results if r.status == "timeout")
    total_findings = sum(r.finding_count for r in tool_results)

    # Read project metrics from inventory if available
    total_files = 0
    total_loc = 0
    inventory_path = os.path.join(audit_dir, "data", "inventory.json")
    if os.path.isfile(inventory_path):
        try:
            with open(inventory_path) as f:
                inv = json.load(f)
            total_files = len(inv.get("files", []))
            total_loc = inv.get("total_loc", 0)
        except (json.JSONDecodeError, OSError):
            pass

    per_tool: list[dict[str, str | int]] = []
    for r in tool_results:
        entry: dict[str, str | int] = {
            "tool": r.tool,
            "status": r.status,
            "findings": r.finding_count,
            "duration_ms": r.duration_ms,
        }
        if r.error:
            entry["error"] = r.error
        per_tool.append(entry)

    report: dict[str, object] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tools_available": len(tool_results),
        "tools_succeeded": succeeded,
        "tools_skipped": skipped,
        "tools_failed": failed,
        "tools_timed_out": timed_out,
        "total_deterministic_findings": total_findings,
        "total_files": total_files,
        "total_loc": total_loc,
        "tool_results": per_tool,
    }

    # Write to disk
    data_dir = os.path.join(audit_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    output_path = os.path.join(data_dir, "pipeline-health.json")
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    return report
