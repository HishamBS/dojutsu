"""Quality gate engine -- reads findings + health report, produces per-tier pass/fail verdict."""
from __future__ import annotations

import json
import os
from collections import Counter
from typing import Any, TypedDict

from readiness_trend import append_trend, get_trend

# ---------------------------------------------------------------------------
# Tier definitions (SonarQube-inspired)
# ---------------------------------------------------------------------------

TIERS: dict[str, dict[str, Any]] = {
    "build": {"name": "Build & Lint", "rules": ["R14"]},
    "security": {"name": "Security", "rules": ["R05"]},
    "secrets": {"name": "Secrets & Env", "rules": ["R05-gitleaks", "R12-env"]},
    "coverage": {"name": "Test Coverage", "rules": ["R08"]},
    "duplication": {"name": "Code Duplication", "rules": ["R01"]},
    "complexity": {"name": "Complexity & Dead Code", "rules": ["R02", "R09"]},
    "architecture": {"name": "Architecture", "rules": ["R02", "R03", "R10"]},
}

# ---------------------------------------------------------------------------
# Default thresholds
# ---------------------------------------------------------------------------

DEFAULT_THRESHOLDS: dict[str, float | int] = {
    "max_critical_vulns": 0,
    "max_high_vulns": 0,
    "max_secrets": 0,
    "min_line_coverage": 60,
    "max_duplication_pct": 5.0,
    "max_cyclomatic_complexity": 20,
    "readiness_threshold": 80,
}

# Severity weights for readiness score calculation
SEVERITY_WEIGHTS: dict[str, float] = {
    "CRITICAL": 10.0,
    "HIGH": 3.0,
    "MEDIUM": 1.0,
    "LOW": 0.2,
}


# ---------------------------------------------------------------------------
# Typed structures
# ---------------------------------------------------------------------------


class TierResult(TypedDict):
    status: str  # "PASS" | "WARN" | "FAIL"
    details: str
    blocker_finding_ids: list[str]


class QualitySummary(TypedDict):
    total_findings: int
    critical: int
    high: int
    medium: int
    low: int
    tools_run: int


class QualityGateResult(TypedDict, total=False):
    readiness_score: float
    overall: str  # "PASS" | "CONDITIONAL" | "FAIL"
    tiers: dict[str, TierResult]
    summary: QualitySummary
    trend: dict[str, Any] | None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_findings(findings_path: str) -> list[dict[str, Any]]:
    """Load all findings from a JSONL file."""
    findings: list[dict[str, Any]] = []
    if not os.path.isfile(findings_path):
        return findings
    with open(findings_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            findings.append(json.loads(line))
    return findings


def _load_health(health_path: str | None) -> dict[str, Any] | None:
    """Load pipeline-health.json if available."""
    if health_path is None or not os.path.isfile(health_path):
        return None
    with open(health_path) as fh:
        return json.load(fh)  # type: ignore[no-any-return]


def _count_by_severity(findings: list[dict[str, Any]]) -> Counter[str]:
    """Count findings by severity level."""
    counts: Counter[str] = Counter()
    for f in findings:
        sev = f.get("severity", "MEDIUM")
        counts[sev] += 1
    return counts


def _count_by_rule(findings: list[dict[str, Any]]) -> Counter[str]:
    """Count findings by rule identifier."""
    counts: Counter[str] = Counter()
    for f in findings:
        rule = f.get("rule", "UNKNOWN")
        counts[rule] += 1
    return counts


def _compute_readiness_score(
    findings: list[dict[str, Any]],
    total_loc: int,
) -> float:
    """Compute readiness score: 100 - (weighted_score / LOC_in_KLOC).

    LOC is expressed in thousands (KLOC).  A project with zero findings
    scores 100.  The score is clamped to [0, 100].
    """
    kloc = max(total_loc / 1000.0, 1.0)  # minimum 1 KLOC to avoid penalizing tiny projects
    weighted = 0.0
    for f in findings:
        sev = f.get("severity", "MEDIUM")
        weighted += SEVERITY_WEIGHTS.get(sev, 1.0)
    score = 100.0 - (weighted / kloc)
    return round(max(0.0, min(100.0, score)), 2)


def _tier_findings(
    findings: list[dict[str, Any]],
    tier_rules: list[str],
) -> list[dict[str, Any]]:
    """Filter findings belonging to a given tier (by rule prefix match)."""
    matched: list[dict[str, Any]] = []
    for f in findings:
        rule = f.get("rule", "")
        for tr in tier_rules:
            if rule == tr or rule.startswith(tr.split("-")[0]):
                matched.append(f)
                break
    return matched


def _evaluate_build_tier(
    findings: list[dict[str, Any]],
    health: dict[str, Any] | None,
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Build & Lint tier."""
    tier_f = _tier_findings(findings, TIERS["build"]["rules"])
    sev = _count_by_severity(tier_f)
    errors = sev.get("CRITICAL", 0) + sev.get("HIGH", 0)

    if errors == 0:
        return TierResult(
            status="PASS",
            details=f"0 type errors, 0 lint errors ({len(tier_f)} total build findings)",
            blocker_finding_ids=[],
        )
    elif errors <= 5:
        return TierResult(
            status="WARN",
            details=f"{errors} build errors ({sev.get('CRITICAL', 0)} critical, {sev.get('HIGH', 0)} high)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="FAIL",
        details=f"{errors} build errors ({sev.get('CRITICAL', 0)} critical, {sev.get('HIGH', 0)} high)",
        blocker_finding_ids=[
            str(finding.get("id", ""))
            for finding in tier_f
            if str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
        ],
    )


def _evaluate_security_tier(
    findings: list[dict[str, Any]],
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Security tier."""
    tier_f = _tier_findings(findings, TIERS["security"]["rules"])
    sev = _count_by_severity(tier_f)
    crits = sev.get("CRITICAL", 0)
    highs = sev.get("HIGH", 0)
    max_crit: int = thresholds.get("max_critical_vulns", 0)
    max_high: int = thresholds.get("max_high_vulns", 0)

    if crits > max_crit:
        return TierResult(
            status="FAIL",
            details=f"{crits} CRITICAL vulnerabilities (max {max_crit})",
            blocker_finding_ids=[
                str(finding.get("id", ""))
                for finding in tier_f
                if str(finding.get("severity", "")) == "CRITICAL"
            ],
        )
    if highs > max_high:
        return TierResult(
            status="FAIL",
            details=f"{highs} HIGH vulnerabilities (max {max_high})",
            blocker_finding_ids=[
                str(finding.get("id", ""))
                for finding in tier_f
                if str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
            ],
        )
    if crits + highs > 0:
        return TierResult(
            status="WARN",
            details=f"{crits} critical, {highs} high vulnerabilities (within thresholds)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="PASS",
        details=f"0 security vulnerabilities",
        blocker_finding_ids=[],
    )


def _evaluate_secrets_tier(
    findings: list[dict[str, Any]],
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Secrets & Env tier."""
    tier_f = _tier_findings(findings, TIERS["secrets"]["rules"])
    max_secrets: int = thresholds.get("max_secrets", 0)
    secret_count = sum(
        1 for f in tier_f if f.get("severity") in ("CRITICAL", "HIGH")
    )

    if secret_count > max_secrets:
        return TierResult(
            status="FAIL",
            details=f"{secret_count} secrets/env issues detected (max {max_secrets})",
            blocker_finding_ids=[
                str(finding.get("id", ""))
                for finding in tier_f
                if str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
            ],
        )
    if len(tier_f) > 0:
        return TierResult(
            status="WARN",
            details=f"{len(tier_f)} env-related findings (no critical secrets)",
            blocker_finding_ids=[],
        )
    return TierResult(status="PASS", details="No secrets or env issues detected", blocker_finding_ids=[])


def _evaluate_coverage_tier(
    health: dict[str, Any] | None,
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Test Coverage tier."""
    min_cov: float = thresholds.get("min_line_coverage", 60)
    if health is None or "coverage_line_pct" not in health:
        return TierResult(
            status="WARN",
            details="No coverage data available",
            blocker_finding_ids=[],
        )
    cov: float = health["coverage_line_pct"]
    if cov >= min_cov:
        return TierResult(
            status="PASS",
            details=f"{cov:.1f}% line coverage (threshold {min_cov}%)",
            blocker_finding_ids=[],
        )
    if cov >= min_cov * 0.8:  # within 80% of threshold = WARN
        return TierResult(
            status="WARN",
            details=f"{cov:.1f}% line coverage (threshold {min_cov}%, close)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="FAIL",
        details=f"{cov:.1f}% line coverage (below {min_cov}% threshold)",
        blocker_finding_ids=[],
    )


def _evaluate_duplication_tier(
    findings: list[dict[str, Any]],
    health: dict[str, Any] | None,
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Code Duplication tier."""
    max_dup: float = thresholds.get("max_duplication_pct", 5.0)
    if health is None or "duplication_pct" not in health:
        return TierResult(status="WARN", details="No duplication data available", blocker_finding_ids=[])
    dup: float = health["duplication_pct"]
    if dup <= max_dup:
        return TierResult(
            status="PASS",
            details=f"{dup:.1f}% duplication (max {max_dup}%)",
            blocker_finding_ids=[],
        )
    if dup <= max_dup * 1.5:  # up to 1.5x threshold = WARN
        return TierResult(
            status="WARN",
            details=f"{dup:.1f}% duplication (max {max_dup}%, elevated)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="FAIL",
        details=f"{dup:.1f}% duplication (exceeds {max_dup}% threshold)",
        blocker_finding_ids=[
            str(finding.get("id", ""))
            for finding in findings
            if str(finding.get("rule", "")) == "R01" and str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
        ],
    )


def _evaluate_complexity_tier(
    findings: list[dict[str, Any]],
    thresholds: dict[str, Any],
) -> TierResult:
    """Evaluate the Complexity & Dead Code tier."""
    tier_f = _tier_findings(findings, TIERS["complexity"]["rules"])
    sev = _count_by_severity(tier_f)
    high_count = sev.get("CRITICAL", 0) + sev.get("HIGH", 0)

    if high_count == 0 and len(tier_f) == 0:
        return TierResult(status="PASS", details="No complexity issues detected", blocker_finding_ids=[])
    if high_count == 0:
        return TierResult(
            status="WARN",
            details=f"{len(tier_f)} complexity findings (none critical/high)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="FAIL",
        details=f"{high_count} high-severity complexity issues out of {len(tier_f)} total",
        blocker_finding_ids=[
            str(finding.get("id", ""))
            for finding in tier_f
            if str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
        ],
    )


def _evaluate_architecture_tier(
    findings: list[dict[str, Any]],
) -> TierResult:
    """Evaluate the Architecture tier."""
    tier_f = _tier_findings(findings, TIERS["architecture"]["rules"])
    sev = _count_by_severity(tier_f)
    high_count = sev.get("CRITICAL", 0) + sev.get("HIGH", 0)

    if high_count == 0 and len(tier_f) == 0:
        return TierResult(status="PASS", details="No architecture violations detected", blocker_finding_ids=[])
    if high_count == 0:
        return TierResult(
            status="WARN",
            details=f"{len(tier_f)} architecture findings (none critical/high)",
            blocker_finding_ids=[],
        )
    return TierResult(
        status="FAIL",
        details=f"{high_count} high-severity architecture violations out of {len(tier_f)} total",
        blocker_finding_ids=[
            str(finding.get("id", ""))
            for finding in tier_f
            if str(finding.get("severity", "")) in ("CRITICAL", "HIGH")
        ],
    )


def _compute_overall(tiers: dict[str, TierResult]) -> str:
    """Derive overall verdict from tier results.

    - ``PASS``: all tiers pass
    - ``CONDITIONAL``: at least one WARN, no FAIL
    - ``FAIL``: any tier fails
    """
    statuses = [t["status"] for t in tiers.values()]
    if "FAIL" in statuses:
        return "FAIL"
    if "WARN" in statuses:
        return "CONDITIONAL"
    return "PASS"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def evaluate_quality_gate(
    findings_path: str,
    health_path: str | None = None,
    thresholds: dict[str, Any] | None = None,
    total_loc: int = 0,
    audit_dir: str | None = None,
) -> QualityGateResult:
    """Evaluate quality gates and return a verdict dict.

    Parameters
    ----------
    findings_path:
        Path to the ``findings.jsonl`` file.
    health_path:
        Optional path to ``pipeline-health.json`` for tool-level metrics.
    thresholds:
        Optional overrides for ``DEFAULT_THRESHOLDS``.
    total_loc:
        Total lines of code in the project (used for readiness scoring).
        Falls back to inventory data if zero and *audit_dir* is given.
    audit_dir:
        Optional audit directory root.  When provided the result is
        written to ``docs/audit/data/quality-gate.json`` and trend
        tracking is updated.
    """
    effective: dict[str, Any] = dict(DEFAULT_THRESHOLDS)
    if thresholds:
        effective.update(thresholds)

    findings = _load_findings(findings_path)
    health = _load_health(health_path)

    # Attempt to resolve total_loc from inventory when not supplied
    if total_loc <= 0 and audit_dir:
        inv_path = os.path.join(audit_dir, "data", "inventory.json")
        if os.path.isfile(inv_path):
            with open(inv_path) as fh:
                inv = json.load(fh)
            total_loc = inv.get("total_loc", 0)

    readiness = _compute_readiness_score(findings, total_loc)

    # Evaluate each tier
    tiers: dict[str, TierResult] = {
        "build": _evaluate_build_tier(findings, health, effective),
        "security": _evaluate_security_tier(findings, effective),
        "secrets": _evaluate_secrets_tier(findings, effective),
        "coverage": _evaluate_coverage_tier(health, effective),
        "duplication": _evaluate_duplication_tier(findings, health, effective),
        "complexity": _evaluate_complexity_tier(findings, effective),
        "architecture": _evaluate_architecture_tier(findings),
    }

    overall = _compute_overall(tiers)

    # Readiness threshold check can override to FAIL
    readiness_thresh: float = effective.get("readiness_threshold", 80)
    if readiness < readiness_thresh and overall != "FAIL":
        overall = "CONDITIONAL" if readiness >= readiness_thresh * 0.8 else "FAIL"

    sev_counts = _count_by_severity(findings)
    tools_run = 0
    if health and "tools_succeeded" in health:
        tools_run = (
            health.get("tools_succeeded", 0)
            + health.get("tools_skipped", 0)
            + health.get("tools_failed", 0)
        )

    summary = QualitySummary(
        total_findings=len(findings),
        critical=sev_counts.get("CRITICAL", 0),
        high=sev_counts.get("HIGH", 0),
        medium=sev_counts.get("MEDIUM", 0),
        low=sev_counts.get("LOW", 0),
        tools_run=tools_run,
    )

    # Trend tracking
    trend_data: dict[str, Any] | None = None
    if audit_dir:
        coverage_val: float | None = None
        if health and "coverage_line_pct" in health:
            coverage_val = health["coverage_line_pct"]
        append_trend(
            audit_dir,
            score=readiness,
            findings=len(findings),
            critical=sev_counts.get("CRITICAL", 0),
            coverage=coverage_val,
        )
        trend_data = get_trend(audit_dir)

    result = QualityGateResult(
        readiness_score=readiness,
        overall=overall,
        tiers=tiers,
        summary=summary,
        trend=trend_data,
    )
    result["blocker_explanation"] = {
        tier_name: payload["blocker_finding_ids"]
        for tier_name, payload in tiers.items()
        if payload["status"] == "FAIL" and payload["blocker_finding_ids"]
    }

    # Write to disk
    if audit_dir:
        gate_path = os.path.join(audit_dir, "data", "quality-gate.json")
        os.makedirs(os.path.dirname(gate_path), exist_ok=True)
        with open(gate_path, "w") as fh:
            json.dump(result, fh, indent=2)
            fh.write("\n")

    return result
