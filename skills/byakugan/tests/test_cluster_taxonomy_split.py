from __future__ import annotations

import os
import sys


SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
)
sys.path.insert(0, SCRIPTS_DIR)

from cluster_findings import split_mixed_clusters


def test_split_mixed_clusters_breaks_large_rule_mixed_bucket() -> None:
    cluster = {
        "type": "cross_cutting",
        "files": [f"src/{index}.ts" for index in range(14)],
        "findings": [
            {"id": f"F-{index:03d}", "rule": "R01" if index < 7 else "R07", "file": f"src/{index}.ts", "line": index + 1, "description": "duplicate constant" if index < 7 else "double cast", "search_pattern": "DEFAULT_BASE_URL" if index < 7 else "as unknown as"}
            for index in range(14)
        ],
    }
    result = split_mixed_clusters([cluster])
    assert len(result) >= 2
    assert all(len({finding["rule"] for finding in item["findings"]}) == 1 for item in result)
