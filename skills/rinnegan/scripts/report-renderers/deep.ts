// The deep-analysis documents of the byakugan stage, rendered from the bundle model: the
// executive brief, the compliance scorecard, the deployment plan and the technical narrative.
import { pyRound } from "@quality/py-round.ts";
import { compareSeverityKeys, field, pyFloat, pyStr, recommendationFromGate, renderedPhase, SEVERITY_LEVELS } from "@rinnegan/report-renderers/model.ts";
import type { BundleModel, Json } from "@rinnegan/report-renderers/model.ts";

const DATE_CHARS = 10;
const TOP_RISKS = 3;
const TOP_PATTERNS = 5;
const WARN_LIMIT = 5;
const LOC_PER_KLOC = 1000;
const MIN_KLOC = 0.1;
const DENSITY_DIGITS = 1;

const severityCount = (severity: Json, level: string): number => {
  const value = severity[level];
  return typeof value === "number" ? Math.trunc(value) : 0;
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const asRecord = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});

// narrative.get(key, fallback) over an object that may be absent or empty.
const textOf = (source: unknown, key: string, fallback: string): string => {
  const record = asRecord(source);
  return Object.hasOwn(record, key) ? pyStr(record[key]) : fallback;
};

export function renderExecutiveBrief(model: BundleModel): string {
  const criticals = model.critical_findings;
  const topRisks = criticals.length > 0 ? criticals.slice(0, TOP_RISKS) : Object.values(model.finding_index).sort(compareSeverityKeys).slice(0, TOP_RISKS);
  const lines = [
    `# Executive Brief: ${model.project_name}`,
    "",
    `**Date:** ${model.generated_at.slice(0, DATE_CHARS)} | **Stack:** ${model.stack} (${model.framework}) | **Readiness:** ${pyFloat(model.readiness_score)}%`,
    "",
    "## Summary",
    "",
    `This audit published ${model.total_findings} findings across ${model.affected_file_count} affected files. ` +
      `The current quality gate verdict is ${field(model.quality_gate, "overall", "FAIL")}. ` +
      `${model.must_fix_ids.length} findings are in the must-fix set before remediation should begin.`,
    "",
    "## Severity",
    "",
    ...SEVERITY_LEVELS.map((level) => `- ${level}: ${severityCount(model.severity, level)}`),
    "",
    "## Top Risks",
    "",
  ];
  topRisks.forEach((finding, index) => lines.push(`${index + 1}. **${field(finding, "id")}** (${field(finding, "severity")}) — ${field(finding, "description")}`));
  lines.push("", "## Recommendation", "", recommendationFromGate(model.quality_gate, model.must_fix_ids.length), "");
  return lines.join("\n");
}

export function renderScorecard(model: BundleModel): string {
  const findings = Object.values(model.finding_index);
  const rules = [...new Set(findings.map((finding) => field(finding, "rule")).filter((rule) => rule !== ""))].sort(compareText);
  const lines = ["# Compliance Scorecard", "", "## Per-Layer Compliance Matrix", ""];
  lines.push(`| Layer | Files | LOC | ${rules.join(" | ")} |`, `|------|------:|----:|${rules.map(() => "---").join("|")}|`);
  for (const layer of model.layers) {
    const cells = rules.map((rule) => {
      const count = layer.findings.filter((finding) => field(finding, "rule") === rule).length;
      if (count === 0) return "PASS";
      return count <= WARN_LIMIT ? `WARN(${count})` : `FAIL(${count})`;
    });
    lines.push(`| ${layer.name} | ${layer.files.length} | ${layer.loc} | ${cells.join(" | ")} |`);
  }
  const density = pyRound(model.total_findings / Math.max(model.total_loc / LOC_PER_KLOC, MIN_KLOC), DENSITY_DIGITS);
  lines.push(
    "",
    "## Key Metrics",
    "",
    `- Finding density: ${pyFloat(density)} per KLOC`,
    `- Readiness: ${pyFloat(model.readiness_score)}%`,
    `- Cluster count: ${model.clusters.length}`,
    `- Root-cause families: ${model.families.length}`,
    "",
    "## Top Systemic Patterns",
    "",
  );
  for (const cluster of model.clusters.slice(0, TOP_PATTERNS)) {
    const rules = cluster.rules.map(pyStr).join(", ");
    lines.push(`- **${cluster.id}** ${cluster.name} — ${cluster.finding_count} findings, ${cluster.max_severity}, rules: ${rules === "" ? "n/a" : rules}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDeploymentPlan(model: BundleModel): string {
  const mustFix = model.must_fix_ids.filter((id) => Object.hasOwn(model.finding_index, id)).map((id) => model.finding_index[id] ?? {});
  const lines = ["# Deployment Plan", "", "## Pre-Merge Checklist", ""];
  if (mustFix.length === 0) {
    lines.push("No HIGH or CRITICAL findings detected. Standard deployment process applies.", "");
    return lines.join("\n");
  }
  for (const finding of mustFix) lines.push(`- [ ] ${field(finding, "id")}: ${field(finding, "description")} (${field(finding, "severity")})`);
  lines.push("", "## Suggested Fix Order", "");
  const perPhase = new Map<number, number>();
  for (const finding of mustFix) perPhase.set(renderedPhase(finding), (perPhase.get(renderedPhase(finding)) ?? 0) + 1);
  for (const phase of model.phases) {
    const count = perPhase.get(phase.phase) ?? 0;
    if (count > 0) lines.push(`${phase.phase}. ${phase.name} — ${count} must-fix findings`);
  }
  lines.push(
    "",
    "## Rollback Plan",
    "",
    "Use standard git revert on the remediation commits for the affected phase if post-deploy verification fails.",
    "",
    "## Smoke Tests",
    "",
    "- [ ] Build and type-check pass",
    "- [ ] Critical user paths tied to must-fix findings are manually verified",
    "- [ ] Security-sensitive endpoints regressions are checked before rollout",
    "",
  );
  return lines.join("\n");
}

export function renderNarrative(model: BundleModel): string {
  const lines = [
    `# ${model.project_name} Technical Audit Narrative`,
    "",
    "## Executive Summary",
    "",
    `The published bundle contains ${model.total_findings} findings across ${model.affected_file_count} affected files. ` +
      `${model.clusters.length} deterministic clusters were produced and ${model.families.length} root-cause families were collapsed before publication. ` +
      `The quality gate verdict is ${field(model.quality_gate, "overall", "FAIL")}.`,
    "",
    "## Cluster Analysis",
    "",
  ];
  for (const cluster of model.clusters) {
    const narrative = isEmpty(cluster.cluster_narrative) ? {} : cluster.cluster_narrative;
    const approach = isEmpty(cluster.recommended_approach) ? {} : cluster.recommended_approach;
    lines.push(
      `### ${cluster.id}: ${cluster.name}`,
      "",
      `- Type: \`${cluster.type}\``,
      `- Findings: \`${cluster.finding_count}\``,
      `- Max severity: \`${cluster.max_severity}\``,
      `- Root pattern: ${cluster.root_pattern === "" ? "n/a" : cluster.root_pattern}`,
      `- Root cause: ${textOf(narrative, "root_cause", "No structured root cause provided.")}`,
      `- Systemic pattern: ${textOf(narrative, "systemic_pattern", "No structured pattern provided.")}`,
      `- Business impact: ${textOf(narrative, "business_impact", "No structured business impact provided.")}`,
      `- Recommended strategy: ${textOf(approach, "strategy", "n/a")}`,
      "",
    );
    if (cluster.impact_rows.length > 0) {
      lines.push("| Finding | File | Line | Effective Severity |", "|---------|------|-----:|--------------------|");
      for (const row of cluster.impact_rows) lines.push(`| ${field(row, "finding_id")} | \`${field(row, "file")}\` | ${field(row, "line")} | ${field(row, "effective_severity")} |`);
      lines.push("");
    }
  }
  lines.push("## Overall Verdict", "", recommendationFromGate(model.quality_gate, model.must_fix_ids.length), "");
  return lines.join("\n");
}

// `value or {}`: an absent, null or empty structure counts as nothing.
const isEmpty = (value: unknown): boolean => value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0);
