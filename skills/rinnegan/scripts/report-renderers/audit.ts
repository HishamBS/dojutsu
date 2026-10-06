// The audit bundle documents of the rinnegan stage, each rendered from the bundle model:
// the master audit, one document per layer, the cross-cutting patterns, the progress page and
// the agent instructions.
import { SPEC_PHASE_NODES } from "@rinnegan/phase-contract.ts";
import { field, percent, pyFloat, pyStr, renderedPhase, SEVERITY_LEVELS } from "@rinnegan/report-renderers/model.ts";
import type { BundleModel, CrossCuttingGroup, Json, LayerDoc } from "@rinnegan/report-renderers/model.ts";

const DATE_CHARS = 10;

const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JAVA_EXTENSIONS: readonly string[] = [".java", ".kt", ".kts"];

// The anchor a finding id gets in its layer document: lower-cased alphanumerics, with every
// other run of characters collapsed to one dash.
export function slugAnchor(text: string): string {
  let slug = "";
  let previousDash = false;
  for (const char of text.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      slug += char;
      previousDash = false;
    } else if (!previousDash) {
      slug += "-";
      previousDash = true;
    }
  }
  return slug.replace(/^-+|-+$/g, "");
}

function languageFor(path: string): string {
  if (TS_EXTENSIONS.some((ext) => path.endsWith(ext))) return "ts";
  if (path.endsWith(".py")) return "python";
  if (JAVA_EXTENSIONS.some((ext) => path.endsWith(ext))) return "java";
  if (path.endsWith(".go")) return "go";
  return "";
}

const codeBlock = (value: string, language: string): string => `\`\`\`${language}\n${value.trimEnd()}\n\`\`\``;

// Findings counted per phase from the model's id-keyed finding index.
function findingsPerPhase(model: BundleModel): Map<number, number> {
  const counts = new Map<number, number>();
  for (const finding of Object.values(model.finding_index)) counts.set(renderedPhase(finding), (counts.get(renderedPhase(finding)) ?? 0) + 1);
  return counts;
}

const severityCount = (severity: Json, level: string): number => {
  const value = severity[level];
  return typeof value === "number" ? Math.trunc(value) : 0;
};

export function renderMasterAudit(model: BundleModel): string {
  const totalFindings = Math.max(model.total_findings, 1);
  const lines = [
    `# ${model.project_name} Codebase Audit`,
    "",
    `> **Date:** ${model.generated_at.slice(0, DATE_CHARS)} | **Stack:** ${model.stack} (${model.framework})`,
    `> **Files:** ${model.total_files_scanned} | **LOC:** ${model.total_loc} | **Findings:** ${model.total_findings}`,
    `> **Affected files:** ${model.affected_file_count} | **Readiness:** ${pyFloat(model.readiness_score)}%`,
    "",
    "## Executive Summary",
    "",
    "### Severity Distribution",
    "",
    "| Severity | Count | % |",
    "|----------|------:|--:|",
  ];
  for (const level of SEVERITY_LEVELS) {
    const count = severityCount(model.severity, level);
    lines.push(`| ${level} | ${count} | ${pyFloat(percent(count, totalFindings))}% |`);
  }

  lines.push("", "### All Critical Findings", "");
  if (model.critical_findings.length > 0) {
    model.critical_findings.forEach((finding, index) => {
      const id = field(finding, "id");
      lines.push(`${index + 1}. **[${id}](layers/${field(finding, "layer", "misc")}.md#${slugAnchor(id)})** \`${field(finding, "file")}:${field(finding, "line")}\` -- ${field(finding, "description")}`);
    });
  } else {
    lines.push("No CRITICAL findings are present in the published bundle.");
  }

  lines.push("", "### Category Breakdown", "", "| Category | Count | |", "|----------|------:|-|");
  for (const category of model.categories) {
    const row = category as Json;
    lines.push(`| ${pyStr(row["name"])} | ${pyStr(row["count"])} | |`);
  }

  lines.push("", "## Layer Audit Index", "", "| Layer | Files | LOC | Findings | Audit Doc |", "|-------|------:|----:|---------:|-----------|");
  for (const layer of model.layers) {
    lines.push(`| ${layer.name} | ${layer.files.length} | ${layer.loc} | ${layer.findings.length} | [${layer.name}.md](${layer.path}) |`);
  }

  lines.push(
    "",
    "## Cross-Cutting Patterns",
    "",
    `See [cross-cutting.md](cross-cutting.md) for ${model.cross_cutting_groups.length} patterns spanning multiple layers.`,
    "",
    "## Remediation Phases",
    "",
    "| Phase | Name | Findings | Status | Phase Doc |",
    "|-------|------|---------:|--------|-----------|",
  );
  const perPhase = findingsPerPhase(model);
  for (const phase of model.phases) {
    lines.push(`| ${phase.phase} | ${phase.name} | ${perPhase.get(phase.phase) ?? 0} | ${pyStr(phase.status)} | [phase-${phase.phase}](${phase.path}) |`);
  }

  lines.push("", "## Phase Dependency DAG", "");
  for (const node of SPEC_PHASE_NODES) lines.push(`- Phase ${node.id}: ${node.name} (${node.rules.join(", ")}) — ${perPhase.get(node.id) ?? 0} findings`);

  lines.push(
    "",
    "## How to Use This Audit",
    "",
    "1. Start with this document for the severity split and phase order.",
    "2. Read layer docs for file-level evidence and target fixes.",
    "3. Use cross-cutting.md for repeated patterns that share one remediation path.",
    "4. Use phase docs and task JSON files to execute fixes in order.",
    "",
  );
  return lines.join("\n");
}

export function renderLayerDoc(model: BundleModel, layer: LayerDoc): string {
  const findings = layer.findings;
  const lines = [
    `# ${layer.name} Layer Audit`,
    "",
    `> **Service:** ${model.project_name} | **Layer:** ${layer.name}`,
    `> **Files:** ${layer.files.length} | **LOC:** ${layer.loc} | **Findings:** ${findings.length}`,
    "",
    "## Findings Summary",
    "",
    "| ID | Line | Severity | Rule | Description |",
    "|----|-----:|----------|------|-------------|",
  ];
  for (const finding of findings) {
    lines.push(`| ${field(finding, "id")} | ${field(finding, "line")} | ${field(finding, "severity")} | ${field(finding, "rule")} | ${field(finding, "description")} |`);
  }

  lines.push("", "## Findings", "");
  for (const finding of findings) {
    const filePath = field(finding, "file");
    const language = languageFor(filePath);
    const currentKey = Object.hasOwn(finding, "current_code") ? "current_code" : "snippet";
    lines.push(
      `### ${field(finding, "id")}`,
      "",
      `<a id="${slugAnchor(field(finding, "id"))}"></a>`,
      "",
      `- File: \`${filePath}:${field(finding, "line")}\``,
      `- Severity: \`${field(finding, "severity")}\``,
      `- Rule: \`${field(finding, "rule")}\``,
      `- Effort: \`${field(finding, "effort")}\``,
      `- Phase: \`${field(finding, "phase")}\``,
      `- Explanation: ${field(finding, "explanation")}`,
      "",
      "**Current code**",
      codeBlock(field(finding, currentKey), language),
      "",
      "**Target code**",
      codeBlock(field(finding, "target_code"), language),
      "",
    );
    const fixPlan = finding["fix_plan"];
    if (Array.isArray(fixPlan) && fixPlan.length > 0) {
      lines.push("**Fix plan**", "");
      for (const stepValue of fixPlan as unknown[]) {
        const step = stepValue as Json;
        lines.push(`- \`${field(step, "action", "edit")}\` \`${field(step, "file")}\` — ${field(step, "description")}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function renderCrossCutting(model: BundleModel): string {
  const lines = ["# Cross-Cutting Patterns", ""];
  const groups: CrossCuttingGroup[] = model.cross_cutting_groups;
  if (groups.length === 0) {
    lines.push("No cross-cutting patterns detected.", "");
    return lines.join("\n");
  }
  for (const group of groups) {
    lines.push(
      `## Pattern: ${group.name}`,
      "",
      `**Rule:** ${group.rule} | **Instances:** ${group.count} across ${group.layers.length} layers | **Severity:** ${group.highest_severity}`,
      "",
      "| # | File | Line | Layer | Finding |",
      "|---|------|-----:|-------|---------|",
    );
    group.instances.forEach((finding, index) => {
      lines.push(`| ${index + 1} | \`${field(finding, "file")}\` | ${field(finding, "line")} | ${field(finding, "layer")} | ${field(finding, "description")} |`);
    });
    lines.push("", `Root-cause guidance: resolve \`${group.name}\` once and apply the same abstraction across all listed files.`, "");
  }
  return lines.join("\n");
}

export function renderProgress(model: BundleModel): string {
  const lines = [
    "# Progress",
    "",
    `- Generated at: \`${model.generated_at}\``,
    `- Audit readiness: \`${field(model.quality_gate, "overall", "FAIL")}\` (${pyFloat(model.readiness_score)}%)`,
    `- Must-fix findings: \`${model.must_fix_ids.length}\``,
    "",
    "| Phase | Name | Findings | Status |",
    "|-------|------|---------:|--------|",
  ];
  const perPhase = findingsPerPhase(model);
  for (const phase of model.phases) lines.push(`| ${phase.phase} | ${phase.name} | ${perPhase.get(phase.phase) ?? 0} | ${pyStr(phase.status)} |`);
  lines.push("");
  return lines.join("\n");
}

export function renderAgentInstructions(model: BundleModel): string {
  const lines = [
    "# Agent Instructions",
    "",
    "Use only the published SSOT files below when planning remediation:",
    "",
    "- `data/findings.jsonl` — canonical findings, severities, cluster IDs, root-cause links",
    "- `data/audit-stats.json` — canonical aggregate metrics",
    "- `data/quality-gate.json` — canonical blocker tiers and finding IDs",
    "- `data/tasks/phase-N-tasks.json` — canonical execution tasks per phase",
    "- `deep/clusters.json` — canonical cluster taxonomy",
    "",
    `Must-fix finding IDs: ${model.must_fix_ids.length > 0 ? model.must_fix_ids.join(", ") : "none"}`,
    "",
  ];
  return lines.join("\n");
}
