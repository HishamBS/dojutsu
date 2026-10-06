import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "@quality-test/project-files.ts";
import { renderBundle } from "@rinnegan/bundle_renderer.ts";
import { writeStats } from "@rinnegan/compute_audit_stats.ts";
import { generatePhaseDocs, generateReportManifest, validatePublicationContract } from "@rinnegan/report_contract.ts";

const json = (value: object): string => JSON.stringify(value, null, 2) + "\n";
const jsonl = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + "\n").join("");

const SECURITY_FINDING = {
  id: "SEC-001", rule: "R05", severity: "CRITICAL", category: "security", file: "src/App.tsx", line: 12, layer: "components", phase: 1,
  description: "Unsafe auth bypass", explanation: "Unsafe auth bypass exists.", current_code: "auth = false", target_code: "auth = true",
  search_pattern: "auth = false", effort: "medium", cross_cutting: true, cross_cutting_group: "R05 auth bypass", cluster_id: "CLU-001",
};
const DRY_FINDING = {
  id: "DRY-001", rule: "R01", severity: "HIGH", category: "ssot-dry", file: "src/util.ts", line: 9, layer: "utils", phase: 3,
  description: "Shared constant duplicated", explanation: "Shared constant duplicated.", current_code: "const URL = 'x'", target_code: "export const URL = 'x'",
  search_pattern: "const URL", effort: "low", cluster_id: "CLU-002", fix_plan: [{ action: "edit", file: "src/util.ts", description: "export it" }],
};
const INVENTORY = {
  root: "fixture", stack: "typescript", framework: "react", total_files: 2, total_loc: 200,
  layers: { components: { files: ["src/App.tsx"], loc: 150 }, utils: { files: ["src/util.ts"], loc: 50 } },
};
const QUALITY_GATE = { overall: "FAIL", tiers: { security: { status: "FAIL", details: "1 CRITICAL vulnerabilities", blocker_finding_ids: ["SEC-001"] } }, blocker_explanation: { security: ["SEC-001"] } };
const TASK_FILE = (phase: number, id: string): string =>
  json({ phase, phase_name: "x", prerequisites: [], status: "not_started", total_tasks: 1, completed: 0, tasks: [{ id }], verification: { command: "echo ok", expected: "ok", description: "ok" } });

const CLUSTERS = {
  clusters: [
    { id: "CLU-001", type: "cross_cutting", name: "Auth bypass", finding_count: 1, max_severity: "CRITICAL", rules: ["R05"], root_pattern: "auth bypass", files: ["src/App.tsx"], finding_ids: ["SEC-001"] },
    { id: "CLU-002", type: "file", name: "Shared constant", finding_count: 1, max_severity: "HIGH", rules: ["R01"], root_pattern: "", files: ["src/util.ts"], finding_ids: ["DRY-001"] },
  ],
};
const IMPACT_ROW = {
  cluster_id: "CLU-001", cluster_label: "Auth bypass", finding_id: "SEC-001", file: "src/App.tsx", line: 12, effective_severity: "CRITICAL-x3",
  cluster_narrative: { root_cause: "missing auth abstraction", systemic_pattern: "auth bypass", business_impact: "users can skip auth", why_it_exists: "unsafe shortcut" },
  recommended_approach: { strategy: "refactor_pattern", description: "centralize auth", fix_order: ["SEC-001"], fix_blast_radius_files: 1, risk_assessment: "medium", validation_steps: ["run auth tests"] },
};
const DEEP_FILES = { "deep/clusters.json": json(CLUSTERS), "deep/impact-analysis.jsonl": jsonl([IMPACT_ROW]), "deep/dependency-graph.json": json({ nodes: [], edges: [] }) };

const BUNDLE_PATHS = ["data/bundle-model.json", "master-audit.md", "cross-cutting.md", "progress.md", "agent-instructions.md", "layers/components.md", "layers/utils.md"];

function auditFixture(findings: object[] = [SECURITY_FINDING, DRY_FINDING], extra: Record<string, string> = {}): string {
  const audit = projectFiles({
    "data/inventory.json": json(INVENTORY),
    "data/findings.jsonl": jsonl(findings),
    "data/quality-gate.json": json(QUALITY_GATE),
    "data/phase-dag.json": json({ nodes: [], edges: [] }),
    "data/tasks/phase-1-tasks.json": TASK_FILE(1, "SEC-001"),
    "data/tasks/phase-3-tasks.json": TASK_FILE(3, "DRY-001"),
    ...extra,
  });
  writeStats(audit);
  return audit;
}

const read = (audit: string, relPath: string): string => readFileSync(join(audit, relPath), "utf8");

describe("renderBundle documents", () => {
  it.each<{ name: string; stage?: "byakugan"; findings?: object[]; extra?: Record<string, string>; file: string; contains: string[]; absent?: string[] }>([
    {
      name: "the master audit: header totals, severity split, critical list, layer index and phase table",
      file: "master-audit.md",
      contains: [
        "# fixture Codebase Audit",
        "> **Files:** 2 | **LOC:** 200 | **Findings:** 2",
        "> **Affected files:** 2 | **Readiness:** 87.0%",
        "| CRITICAL | 1 | 50.0% |",
        "| HIGH | 1 | 50.0% |",
        "| MEDIUM | 0 | 0.0% |",
        "1. **[SEC-001](layers/components.md#sec-001)** `src/App.tsx:12` -- Unsafe auth bypass",
        "| security | 1 | |",
        "| ssot-dry | 1 | |",
        "| components | 1 | 150 | 1 | [components.md](layers/components.md) |",
        "| utils | 1 | 50 | 1 | [utils.md](layers/utils.md) |",
        "See [cross-cutting.md](cross-cutting.md) for 1 patterns spanning multiple layers.",
        "| 1 | Security | 1 | not_started | [phase-1](phases/phase-1-security.md) |",
        "| 2 | Typing | 0 | clear | [phase-2](phases/phase-2-typing.md) |",
        "| 3 | SSOT/DRY | 1 | not_started | [phase-3](phases/phase-3-ssot-dry.md) |",
        "- Phase 4: Architecture (R02, R03) — 0 findings",
      ],
    },
    {
      name: "the master audit without critical findings says so",
      findings: [DRY_FINDING],
      file: "master-audit.md",
      contains: ["No CRITICAL findings are present in the published bundle.", "| CRITICAL | 0 | 0.0% |", "| HIGH | 1 | 100.0% |", "> **Affected files:** 1 | **Readiness:** 97.0%"],
      absent: ["layers/components.md"],
    },
    {
      name: "a layer document: summary row, anchor, evidence, code blocks in the file's language and the fix plan",
      file: "layers/utils.md",
      contains: [
        "# utils Layer Audit",
        "> **Service:** fixture | **Layer:** utils",
        "> **Files:** 1 | **LOC:** 50 | **Findings:** 1",
        "| DRY-001 | 9 | HIGH | R01 | Shared constant duplicated |",
        '<a id="dry-001"></a>',
        "- File: `src/util.ts:9`",
        "- Phase: `3`",
        "**Current code**\n```ts\nconst URL = 'x'\n```",
        "**Target code**\n```ts\nexport const URL = 'x'\n```",
        "**Fix plan**\n\n- `edit` `src/util.ts` — export it",
      ],
    },
    {
      name: "cross-cutting patterns list their instances and the shared remediation",
      file: "cross-cutting.md",
      contains: [
        "## Pattern: R05 auth bypass",
        "**Rule:** R05 | **Instances:** 1 across 1 layers | **Severity:** CRITICAL",
        "| 1 | `src/App.tsx` | 12 | components | Unsafe auth bypass |",
        "Root-cause guidance: resolve `R05 auth bypass` once and apply the same abstraction across all listed files.",
      ],
    },
    { name: "no cross-cutting findings means no patterns", findings: [DRY_FINDING], file: "cross-cutting.md", contains: ["No cross-cutting patterns detected."], absent: ["## Pattern"] },
    {
      name: "progress and the agent instructions carry the must-fix set in severity order",
      file: "agent-instructions.md",
      contains: ["Must-fix finding IDs: SEC-001, DRY-001", "- `data/findings.jsonl` — canonical findings, severities, cluster IDs, root-cause links"],
    },
    {
      name: "progress shows the gate verdict, readiness and the phase table",
      file: "progress.md",
      contains: ["- Audit readiness: `FAIL` (87.0%)", "- Must-fix findings: `2`", "| 1 | Security | 1 | not_started |", "| 0 | Foundation | 0 | clear |"],
    },
    {
      name: "a finding without a layer is filed under misc and one with a null target prints None",
      findings: [{ ...DRY_FINDING, layer: undefined, target_code: null }],
      file: "layers/misc.md",
      contains: ["# misc Layer Audit", "> **Files:** 0 | **LOC:** 0 | **Findings:** 1", "**Target code**\n```ts\nNone\n```"],
    },
    {
      name: "the executive brief: totals, severity, top risks and the gate's recommendation",
      stage: "byakugan",
      extra: DEEP_FILES,
      file: "deep/executive-brief.md",
      contains: [
        "# Executive Brief: fixture",
        "| **Stack:** typescript (react) | **Readiness:** 87.0%",
        "This audit published 2 findings across 2 affected files. The current quality gate verdict is FAIL. 2 findings are in the must-fix set before remediation should begin.",
        "- CRITICAL: 1\n- HIGH: 1\n- MEDIUM: 0",
        "1. **SEC-001** (CRITICAL) — Unsafe auth bypass",
        "Do not begin remediation until the 2 must-fix findings are assigned by phase and the published bundle remains validator-clean after every rerender.",
      ],
      absent: ["DRY-001"],
    },
    {
      name: "the executive brief lists the worst findings when none is critical",
      stage: "byakugan",
      findings: [DRY_FINDING],
      extra: DEEP_FILES,
      file: "deep/executive-brief.md",
      contains: ["1. **DRY-001** (HIGH) — Shared constant duplicated", "1 findings are in the must-fix set"],
    },
    {
      name: "the scorecard: a pass, warn or fail cell per layer and rule, the density and the top clusters",
      stage: "byakugan",
      extra: DEEP_FILES,
      file: "deep/scorecard.md",
      contains: [
        "| Layer | Files | LOC | R01 | R05 |",
        "|------|------:|----:|---|---|",
        "| components | 1 | 150 | PASS | WARN(1) |",
        "| utils | 1 | 50 | WARN(1) | PASS |",
        "- Finding density: 10.0 per KLOC",
        "- Readiness: 87.0%",
        "- Cluster count: 2",
        "- Root-cause families: 0",
        "- **CLU-001** Auth bypass — 1 findings, CRITICAL, rules: R05",
        "- **CLU-002** Shared constant — 1 findings, HIGH, rules: R01",
      ],
    },
    {
      name: "the deployment plan: a must-fix checklist and the phases that hold them",
      stage: "byakugan",
      extra: DEEP_FILES,
      file: "deep/deployment-plan.md",
      contains: [
        "- [ ] SEC-001: Unsafe auth bypass (CRITICAL)",
        "- [ ] DRY-001: Shared constant duplicated (HIGH)",
        "1. Security — 1 must-fix findings",
        "3. SSOT/DRY — 1 must-fix findings",
        "## Rollback Plan",
        "- [ ] Build and type-check pass",
      ],
    },
    {
      name: "the deployment plan without must-fix findings is the standard process",
      stage: "byakugan",
      findings: [{ ...DRY_FINDING, severity: "LOW" }],
      extra: DEEP_FILES,
      file: "deep/deployment-plan.md",
      contains: ["No HIGH or CRITICAL findings detected. Standard deployment process applies."],
      absent: ["## Rollback Plan"],
    },
    {
      name: "the narrative: each cluster with its structured analysis, impact rows and the verdict",
      stage: "byakugan",
      extra: DEEP_FILES,
      file: "deep/narrative.md",
      contains: [
        "# fixture Technical Audit Narrative",
        "The published bundle contains 2 findings across 2 affected files. 2 deterministic clusters were produced and 0 root-cause families were collapsed before publication. The quality gate verdict is FAIL.",
        "### CLU-001: Auth bypass",
        "- Type: `cross_cutting`",
        "- Root pattern: auth bypass",
        "- Root cause: missing auth abstraction",
        "- Business impact: users can skip auth",
        "- Recommended strategy: refactor_pattern",
        "| SEC-001 | `src/App.tsx` | 12 | CRITICAL-x3 |",
        "### CLU-002: Shared constant",
        "- Root pattern: n/a",
        "- Root cause: No structured root cause provided.",
        "- Recommended strategy: n/a",
        "## Overall Verdict",
      ],
    },
  ])("$name", ({ stage, findings, extra, file, contains, absent }) => {
    const audit = auditFixture(findings, extra);
    const rendered = renderBundle(audit, stage ?? "rinnegan", false);
    if (stage === "byakugan") expect(rendered.written.slice(-4)).toEqual(["deep/executive-brief.md", "deep/scorecard.md", "deep/deployment-plan.md", "deep/narrative.md"]);
    const content = read(audit, file);
    for (const expected of contains) expect(content).toContain(expected);
    for (const forbidden of absent ?? []) expect(content).not.toContain(forbidden);
    expect(content.endsWith("\n")).toBe(true);
  });
});

describe("renderBundle drift detection", () => {
  it.each<{ name: string; change: (audit: string) => void; mismatches: string[]; after?: (audit: string) => void }>([
    { name: "a freshly rendered bundle checks clean", change: () => undefined, mismatches: [] },
    {
      name: "a master audit whose finding count was edited is reported and left as edited",
      change: (audit) => writeFileSync(join(audit, "master-audit.md"), read(audit, "master-audit.md").replace("**Findings:** 2", "**Findings:** 9")),
      mismatches: ["master-audit.md"],
      after: (audit) => expect(read(audit, "master-audit.md")).toContain("**Findings:** 9"),
    },
    {
      name: "a missing document is reported and not recreated by the check",
      change: (audit) => rmSync(join(audit, "layers", "utils.md")),
      mismatches: ["layers/utils.md"],
      after: (audit) => expect(existsSync(join(audit, "layers", "utils.md"))).toBe(false),
    },
    {
      name: "extra trailing blank lines are drift",
      change: (audit) => writeFileSync(join(audit, "progress.md"), read(audit, "progress.md") + "\n\n"),
      mismatches: ["progress.md"],
    },
    {
      name: "a new finding drifts the model and every document that counts it",
      change: (audit) => writeFileSync(join(audit, "data", "findings.jsonl"), read(audit, "data/findings.jsonl") + jsonl([{ ...DRY_FINDING, id: "DRY-002", line: 20 }])),
      mismatches: ["data/bundle-model.json", "master-audit.md", "progress.md", "agent-instructions.md", "layers/utils.md"],
    },
  ])("$name", ({ change, mismatches, after }) => {
    const audit = auditFixture();
    const rendered = renderBundle(audit, "rinnegan", false);
    expect(rendered).toEqual({ written: BUNDLE_PATHS, mismatches: [], count: 7 });
    change(audit);
    expect(renderBundle(audit, "rinnegan", true)).toEqual({ written: [], mismatches, count: 7 });
    after?.(audit);
  });

  it("rendering again changes no byte, the generation stamp included", () => {
    const audit = auditFixture();
    renderBundle(audit, "rinnegan", false);
    const before = BUNDLE_PATHS.map((relPath) => read(audit, relPath));
    renderBundle(audit, "rinnegan", false);
    expect(BUNDLE_PATHS.map((relPath) => read(audit, relPath))).toEqual(before);
    expect(JSON.parse(read(audit, "data/bundle-model.json"))).toHaveProperty("generated_at");
  });
});

const RENDERER_CLI = join(import.meta.dir, "..", "scripts", "bundle_renderer.ts");

describe("bundle renderer command line", () => {
  it.each<{ name: string; args: (audit: string) => string[]; beforeRun?: (audit: string) => void; status: number; stdout: (audit: string) => string }>([
    { name: "without arguments it prints its usage and fails", args: () => [], status: 1, stdout: () => "Usage: bundle_renderer.ts <render|check> <audit_dir> <rinnegan|byakugan>\n" },
    { name: "render writes the bundle and counts its files", args: (audit) => ["render", audit, "rinnegan"], status: 0, stdout: () => "BUNDLE_RENDER_COMPLETE stage=rinnegan files=7\n" },
    { name: "the stage defaults to rinnegan", args: (audit) => ["render", audit], status: 0, stdout: () => "BUNDLE_RENDER_COMPLETE stage=rinnegan files=7\n" },
    {
      name: "check passes on a rendered bundle",
      args: (audit) => ["check", audit, "rinnegan"],
      beforeRun: (audit) => renderBundle(audit, "rinnegan", false),
      status: 0,
      stdout: () => "BUNDLE_RENDER_VALID stage=rinnegan\n",
    },
    {
      name: "check names every drifted document and fails",
      args: (audit) => ["check", audit, "rinnegan"],
      beforeRun: (audit) => {
        renderBundle(audit, "rinnegan", false);
        writeFileSync(join(audit, "progress.md"), "edited\n");
        rmSync(join(audit, "cross-cutting.md"));
      },
      status: 1,
      stdout: () => "BUNDLE_RENDER_MISMATCH stage=rinnegan\n- cross-cutting.md\n- progress.md\n",
    },
    { name: "an unknown command is refused", args: (audit) => ["bake", audit], status: 1, stdout: () => "Unknown command: bake\n" },
  ])("$name", ({ args, beforeRun, status, stdout }) => {
    const audit = auditFixture();
    beforeRun?.(audit);
    const result = Bun.spawnSync([process.execPath, RENDERER_CLI, ...args(audit)], { stdout: "pipe", stderr: "pipe" });
    expect([result.exitCode, result.stdout.toString()]).toEqual([status, stdout(audit)]);
  });
});

const SECURITY_TASK = { id: "SEC-001", severity: "CRITICAL", file: "src/App.tsx", line: 12, status: "pending", search_pattern: "auth = false", effort: "medium", explanation: "Unsafe auth bypass exists.", target_code: "  auth = true  \nsecond line" };
const PLAN_TASK = { id: "DRY-001", severity: "HIGH", file: "src/util.ts", line: 9, status: "pending", search_pattern: "const URL", effort: "low", explanation: "Shared constant duplicated.", target_code: null, fix_plan: [{ action: "edit" }, { action: "create" }, {}] };
const taskFileWith = (phase: number, name: string, tasks: object[], extra: object = {}): string =>
  json({ phase, phase_name: name, prerequisites: ["phase-0"], status: "not_started", total_tasks: tasks.length, completed: 0, tasks, verification: { command: "echo ok", expected: "ok", description: "ok" }, ...extra });

describe("generatePhaseDocs", () => {
  it.each<{ name: string; extra?: Record<string, string>; findings?: object[]; file: string; contains: string[]; absent?: string[] }>([
    {
      name: "a phase with tasks: header, verification, task table and details with the fix summary",
      extra: { "data/tasks/phase-1-tasks.json": taskFileWith(1, "Security (R05)", [SECURITY_TASK]) },
      file: "phases/phase-1-security.md",
      contains: [
        "# Phase 1: Security (R05)",
        "> **Rules:** R05 | **Prerequisites:** phase-0",
        "> **Tasks:** 1 | **Completed:** 0 | **Status:** not_started",
        "This phase covers `Security` findings and is generated deterministically from task data.",
        "- Command: `echo ok`\n- Expected: `ok`\n- Description: ok",
        "| SEC-001 | CRITICAL | `src/App.tsx` | 12 | pending |",
        "- File: `src/App.tsx:12`",
        "- Search pattern: `auth = false`",
        "- Effort: `medium`",
        "- Fix: Replace with `auth = true`.",
      ],
    },
    {
      name: "a task without target code summarises its fix plan, at most four actions",
      extra: { "data/tasks/phase-3-tasks.json": taskFileWith(3, "SSOT/DRY (R01)", [PLAN_TASK]) },
      file: "phases/phase-3-ssot-dry.md",
      contains: ["- Fix: Plan: edit, create, edit."],
    },
    {
      name: "a task with neither says so",
      extra: { "data/tasks/phase-3-tasks.json": taskFileWith(3, "SSOT/DRY (R01)", [{ id: "X-1", target_code: "   " }]) },
      file: "phases/phase-3-ssot-dry.md",
      contains: ["- Fix: No deterministic replacement captured."],
    },
    {
      name: "a phase without a task file is clear, takes its prerequisites from the DAG and needs manual verification",
      file: "phases/phase-4-architecture.md",
      contains: [
        "# Phase 4: Architecture (R02, R03)",
        "> **Rules:** R02, R03 | **Prerequisites:** phase-3",
        "> **Tasks:** 0 | **Completed:** 0 | **Status:** clear",
        "- Command: `echo MANUAL_REVIEW_REQUIRED`",
        "No findings are assigned to this phase.",
        "This phase is currently clear.",
      ],
    },
    {
      name: "a phase with findings but no task file counts them and is not started",
      findings: [{ ...DRY_FINDING, phase: 6 }, { ...DRY_FINDING, id: "DRY-002", phase: 6 }],
      file: "phases/phase-6-performance.md",
      contains: ["> **Rules:** R04 | **Prerequisites:** phase-4", "> **Tasks:** 2 | **Completed:** 0 | **Status:** not_started"],
    },
    {
      name: "the first phase has no prerequisites",
      file: "phases/phase-0-foundation.md",
      contains: ["> **Rules:** R14 | **Prerequisites:** None"],
    },
  ])("$name", ({ extra, findings, file, contains, absent }) => {
    const audit = auditFixture(findings, extra);
    const written = generatePhaseDocs(audit);
    expect(written).toEqual(Array.from({ length: 11 }, (_, i) => `phases/phase-${i}-${["foundation", "security", "typing", "ssot-dry", "architecture", "clean-code", "performance", "data-integrity", "refactoring", "verification", "documentation"][i]}.md`));
    const content = read(audit, file);
    for (const expected of contains) expect(content).toContain(expected);
    for (const forbidden of absent ?? []) expect(content).not.toContain(forbidden);
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });
});

describe("generateReportManifest", () => {
  it.each<{ name: string; findings?: object[]; withoutStats?: boolean; layerDocs: string[] }>([
    { name: "layer documents follow the audit statistics' layer order", findings: [DRY_FINDING, { ...DRY_FINDING, id: "DRY-002" }, SECURITY_FINDING], layerDocs: ["layers/utils.md", "layers/components.md"] },
    { name: "without statistics the inventory's layers, sorted, name them", withoutStats: true, layerDocs: ["layers/components.md", "layers/utils.md"] },
  ])("$name", ({ findings, withoutStats, layerDocs }) => {
    const audit = auditFixture(findings);
    if (withoutStats === true) rmSync(join(audit, "data", "audit-stats.json"));
    const manifest = generateReportManifest(audit);
    expect(manifest.canonical_paths.layer_docs).toEqual(layerDocs);
    expect(manifest.canonical_paths.phase_docs).toHaveLength(11);
    expect(manifest.canonical_paths.phase_docs[3]).toBe("phases/phase-3-ssot-dry.md");
    expect(manifest.authoritative_sources).toEqual({
      findings: "data/findings.jsonl",
      metrics: "data/audit-stats.json",
      phase_dag: "data/phase-dag.json",
      phase_tasks: "data/tasks/phase-*-tasks.json",
      clusters: "deep/clusters.json",
    });
    expect(manifest.required_outputs.rinnegan).toEqual([
      "master-audit.md", "cross-cutting.md", "progress.md", "agent-instructions.md",
      "data/findings.jsonl", "data/inventory.json", "data/phase-dag.json", "data/audit-stats.json", "data/report-manifest.json",
      ...layerDocs,
      ...manifest.canonical_paths.phase_docs,
    ]);
    expect(manifest.required_outputs.byakugan).toEqual([
      "deep/dependency-graph.json", "deep/clusters.json", "deep/impact-analysis.jsonl",
      "deep/narrative.md", "deep/scorecard.md", "deep/deployment-plan.md", "deep/executive-brief.md",
    ]);
    expect(manifest.version).toBe(1);
    expect(read(audit, "data/report-manifest.json")).toBe(JSON.stringify(manifest, null, 2) + "\n");
  });
});

type Stage = "rinnegan" | "byakugan";

// An audit directory published the way the pipeline does: statistics, phase documents,
// manifest, then the rendered bundle.
function publishedFixture(stage: Stage, findings?: object[]): string {
  const audit = auditFixture(findings, stage === "byakugan" ? DEEP_FILES : {});
  generatePhaseDocs(audit);
  generateReportManifest(audit);
  renderBundle(audit, stage, false);
  return audit;
}

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject => value as JsonObject;
const list = (value: unknown): unknown[] => value as unknown[];
const editJson = (audit: string, relPath: string, change: (data: JsonObject) => void): void => {
  const data = obj(JSON.parse(read(audit, relPath)));
  change(data);
  writeFileSync(join(audit, relPath), json(data));
};
const rewriteFindings = (audit: string, change: (rows: Record<string, unknown>[]) => void): void => {
  const rows = read(audit, "data/findings.jsonl").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  change(rows);
  writeFileSync(join(audit, "data", "findings.jsonl"), jsonl(rows));
};

describe("validatePublicationContract", () => {
  it.each<{ name: string; stage?: Stage; mutate?: (audit: string) => void; errors: string[] }>([
    { name: "a published rinnegan bundle is valid", errors: [] },
    { name: "a published byakugan bundle is valid", stage: "byakugan", errors: [] },
    {
      name: "a link to a document that does not exist",
      mutate: (audit) => writeFileSync(join(audit, "master-audit.md"), read(audit, "master-audit.md") + "\n[Broken](layers/services-audit.md)\n"),
      errors: ["master-audit.md has broken link: layers/services-audit.md", "deterministic render drift: master-audit.md"],
    },
    {
      name: "a non-REVIEW finding with neither target code nor a fix plan",
      mutate: (audit) => {
        rewriteFindings(audit, (rows) => Object.assign(rows[0] ?? {}, { target_code: null, fix_plan: null }));
        writeStats(audit);
      },
      errors: ["null-fix contract violated: 1/2 non-REVIEW findings are missing both target_code and fix_plan"],
    },
    { name: "a required output that was never written", mutate: (audit) => rmSync(join(audit, "phases", "phase-3-ssot-dry.md")), errors: ["missing required output: phases/phase-3-ssot-dry.md"] },
    {
      name: "statistics whose finding total disagrees with the findings and the master audit",
      mutate: (audit) => editJson(audit, "data/audit-stats.json", (data) => (data["total_findings"] = 5)),
      errors: ["audit-stats total_findings=5 != findings.jsonl lines=2", "master-audit.md findings=2 != audit-stats total_findings=5"],
    },
    {
      name: "a severity count that the findings do not support",
      mutate: (audit) => editJson(audit, "data/audit-stats.json", (data) => (obj(data["severity"])["HIGH"] = 9)),
      errors: ["audit-stats severity HIGH=9 != findings-derived 1", "master-audit.md severity HIGH=1 != audit-stats 9"],
    },
    {
      name: "a phase count that the findings do not support",
      mutate: (audit) => editJson(audit, "data/audit-stats.json", (data) => (obj(list(data["phases"])[0])["findings"] = 7)),
      errors: ["audit-stats phase 1=7 != findings-derived 1", "master-audit.md phase 1 count=1 != audit-stats 7"],
    },
    {
      name: "an affected file count and a LOC total that disagree",
      mutate: (audit) =>
        editJson(audit, "data/audit-stats.json", (data) => {
          data["affected_files"] = 9;
          data["total_loc"] = 999;
        }),
      errors: ["audit-stats affected_files=9 != findings-derived 2", "master-audit.md loc=200 != audit-stats total_loc=999"],
    },
    { name: "statistics that are missing", mutate: (audit) => rmSync(join(audit, "data", "audit-stats.json")), errors: ["audit-stats.json missing or unreadable"] },
    {
      name: "a task file whose declared total is not its task count",
      mutate: (audit) => editJson(audit, "data/tasks/phase-1-tasks.json", (data) => (data["total_tasks"] = 3)),
      errors: ["data/tasks/phase-1-tasks.json total_tasks=3 != actual tasks=1"],
    },
    {
      name: "a task file holding fewer tasks than the phase has findings",
      mutate: (audit) =>
        editJson(audit, "data/tasks/phase-3-tasks.json", (data) => {
          data["tasks"] = [];
          data["total_tasks"] = 0;
        }),
      errors: ["data/tasks/phase-3-tasks.json tasks=0 != findings-derived phase count=1"],
    },
    { name: "a phase with findings and no task file", mutate: (audit) => rmSync(join(audit, "data", "tasks", "phase-1-tasks.json")), errors: ["missing phase task file for phase 1"] },
    {
      name: "a finding without a cluster",
      stage: "byakugan",
      mutate: (audit) => rewriteFindings(audit, (rows) => delete rows[1]?.["cluster_id"]),
      errors: ["finding DRY-001 missing cluster_id"],
    },
    {
      name: "a finding naming a cluster that does not exist",
      stage: "byakugan",
      mutate: (audit) => rewriteFindings(audit, (rows) => Object.assign(rows[1] ?? {}, { cluster_id: "CLU-9" })),
      errors: ["finding DRY-001 references unknown cluster_id CLU-9"],
    },
    {
      name: "an empty cluster set",
      stage: "byakugan",
      mutate: (audit) => writeFileSync(join(audit, "deep", "clusters.json"), json({ clusters: [] })),
      errors: ["clusters.json missing clusters"],
    },
    {
      name: "a parent that does not exist and one that is not a root cause",
      mutate: (audit) => rewriteFindings(audit, (rows) => Object.assign(rows[1] ?? {}, { parent_finding_id: "GHOST-1" })),
      errors: ["finding DRY-001 references missing parent_finding_id GHOST-1", "finding DRY-001 parent_finding_id GHOST-1 is not marked root cause"],
    },
    {
      name: "a parent that exists but is not marked as a root cause",
      mutate: (audit) => rewriteFindings(audit, (rows) => Object.assign(rows[1] ?? {}, { parent_finding_id: "SEC-001" })),
      errors: ["finding DRY-001 parent_finding_id SEC-001 is not marked root cause"],
    },
    {
      name: "a family rooted at a finding that does not exist",
      mutate: (audit) => writeFileSync(join(audit, "data", "finding-families.json"), json({ families: [{ id: "FAM-1", root_finding_id: "NOPE-1" }] })),
      errors: ["family FAM-1 references missing root finding NOPE-1"],
    },
    {
      name: "a quality gate blocker that names a missing finding",
      mutate: (audit) => editJson(audit, "data/quality-gate.json", (data) => (obj(data["blocker_explanation"])["security"] = ["GHOST-1"])),
      errors: ["quality-gate security blocker references missing finding id GHOST-1"],
    },
    {
      name: "a failing gate tier without blockers and a blocker list that is not a list",
      mutate: (audit) =>
        editJson(audit, "data/quality-gate.json", (data) => {
          obj(obj(data["tiers"])["security"])["blocker_finding_ids"] = [];
          obj(data["blocker_explanation"])["security"] = "SEC-001";
        }),
      errors: ["quality-gate tier security FAIL has no blocker_finding_ids", "quality-gate blocker_explanation for security is not a list"],
    },
    {
      name: "a document edited after rendering",
      mutate: (audit) => writeFileSync(join(audit, "progress.md"), "edited\n"),
      errors: ["deterministic render drift: progress.md"],
    },
  ])("$name", ({ stage, mutate, errors }) => {
    const bundleStage = stage ?? "rinnegan";
    const audit = publishedFixture(bundleStage);
    mutate?.(audit);
    const result = validatePublicationContract(audit, bundleStage);
    expect(result.stage).toBe(bundleStage);
    if (errors.length === 0) expect(result.errors).toEqual([]);
    expect(result.ok).toBe(errors.length === 0);
    for (const expected of errors) expect(result.errors).toContain(expected);
    const verdict = JSON.parse(read(audit, "data/bundle-verdict.json")) as { ok: boolean; stage: string; errors: string[]; generated_at: string; source_hashes: Record<string, string> };
    expect([verdict.ok, verdict.stage, verdict.errors]).toEqual([result.ok, bundleStage, result.errors]);
    expect(verdict.generated_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const hashed = ["data/findings.jsonl", "data/audit-stats.json", "data/quality-gate.json", "data/report-manifest.json", "data/bundle-model.json", ...(bundleStage === "byakugan" ? ["deep/clusters.json", "deep/impact-analysis.jsonl"] : [])].filter((relPath) => existsSync(join(audit, relPath)));
    expect(Object.keys(verdict.source_hashes)).toEqual(hashed);
    for (const relPath of hashed) expect(verdict.source_hashes[relPath]).toBe(createHash("sha256").update(readFileSync(join(audit, relPath))).digest("hex"));
  });
});

const CONTRACT_CLI = join(import.meta.dir, "..", "scripts", "report_contract.ts");

describe("report contract command line", () => {
  it.each<{ name: string; args: (audit: string) => string[]; spoil?: (audit: string) => void; status: number; stdout: (audit: string) => string }>([
    { name: "without arguments it prints its usage and fails", args: () => [], status: 1, stdout: () => "Usage: report_contract.ts <phase-docs|manifest|validate> <audit_dir> [stage]\n" },
    { name: "phase-docs writes one document per phase", args: (audit) => ["phase-docs", audit], status: 0, stdout: () => "Generated 11 phase docs\n" },
    { name: "manifest writes the report manifest", args: (audit) => ["manifest", audit], status: 0, stdout: () => "Generated report-manifest.json\n" },
    { name: "validate accepts a published bundle", args: (audit) => ["validate", audit], status: 0, stdout: () => "PUBLICATION_VALID: rinnegan\n" },
    { name: "validate takes the stage as its third argument", args: (audit) => ["validate", audit, "byakugan"], status: 1, stdout: () => "PUBLICATION_INVALID: byakugan\n- missing required output: deep/dependency-graph.json\n- missing required output: deep/clusters.json\n- missing required output: deep/impact-analysis.jsonl\n- missing required output: deep/narrative.md\n- missing required output: deep/scorecard.md\n- missing required output: deep/deployment-plan.md\n- missing required output: deep/executive-brief.md\n- clusters.json missing clusters\n- finding SEC-001 missing cluster_id\n- finding DRY-001 missing cluster_id\n- deterministic render drift: deep/executive-brief.md\n- deterministic render drift: deep/scorecard.md\n- deterministic render drift: deep/deployment-plan.md\n- deterministic render drift: deep/narrative.md\n" },
    {
      name: "validate lists every contract error and fails",
      args: (audit) => ["validate", audit, "rinnegan"],
      spoil: (audit) => rmSync(join(audit, "phases", "phase-3-ssot-dry.md")),
      status: 1,
      stdout: () => "PUBLICATION_INVALID: rinnegan\n- missing required output: phases/phase-3-ssot-dry.md\n- master-audit.md has broken link: phases/phase-3-ssot-dry.md\n",
    },
    { name: "an unknown command is refused", args: (audit) => ["bake", audit], status: 1, stdout: () => "Unknown command: bake\n" },
  ])("$name", ({ args, spoil, status, stdout }) => {
    const audit = publishedFixture("rinnegan", [{ ...SECURITY_FINDING, cluster_id: undefined }, { ...DRY_FINDING, cluster_id: undefined }]);
    spoil?.(audit);
    const result = Bun.spawnSync([process.execPath, CONTRACT_CLI, ...args(audit)], { stdout: "pipe", stderr: "pipe" });
    expect([result.exitCode, result.stdout.toString()]).toEqual([status, stdout(audit)]);
  });
});
