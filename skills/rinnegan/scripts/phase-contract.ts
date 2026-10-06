// The remediation phase contract: the eleven phases, the DAG that orders them, the file slug
// of each phase's report and the Rasengan configuration defaults. Every consumer (phase
// tasks, the pipeline, the report contract, the bundle renderer) reads them from here.

export type PhaseNode = { id: number; name: string; rules: readonly string[] };
export type PhaseEdge = { from: number; to: number };

export const MIN_PHASE = 0;
export const MAX_PHASE = 10;

export const SPEC_PHASE_NODES: readonly PhaseNode[] = [
  { id: 0, name: "Foundation", rules: ["R14"] },
  { id: 1, name: "Security", rules: ["R05"] },
  { id: 2, name: "Typing", rules: ["R07"] },
  { id: 3, name: "SSOT/DRY", rules: ["R01"] },
  { id: 4, name: "Architecture", rules: ["R02", "R03"] },
  { id: 5, name: "Clean Code", rules: ["R09", "R13"] },
  { id: 6, name: "Performance", rules: ["R04"] },
  { id: 7, name: "Data Integrity", rules: ["R12"] },
  { id: 8, name: "Refactoring", rules: ["R10"] },
  { id: 9, name: "Verification", rules: ["R16", "R08"] },
  { id: 10, name: "Documentation", rules: ["R11"] },
];

export const PHASE_FILE_SLUGS: Readonly<Record<number, string>> = {
  0: "foundation",
  1: "security",
  2: "typing",
  3: "ssot-dry",
  4: "architecture",
  5: "clean-code",
  6: "performance",
  7: "data-integrity",
  8: "refactoring",
  9: "verification",
  10: "documentation",
};

export const SPEC_PHASE_EDGES: readonly PhaseEdge[] = [
  { from: 0, to: 1 },
  { from: 0, to: 2 },
  { from: 1, to: 3 },
  { from: 2, to: 3 },
  { from: 3, to: 4 },
  { from: 3, to: 7 },
  { from: 4, to: 5 },
  { from: 4, to: 6 },
  { from: 5, to: 8 },
  { from: 6, to: 8 },
  { from: 7, to: 9 },
  { from: 8, to: 9 },
  { from: 9, to: 10 },
];

export const RASENGAN_CONFIG_DEFAULTS = {
  commit_strategy: "per-phase",
  session_bridging: "json",
  stale_fix_mode: "adapt",
  mini_scan_after_phase: true,
  full_verify_after_phase: false,
  full_verify_after_all: true,
  max_retries_per_phase: 2,
  max_retries_per_task: 1,
} as const;

// A phase number found in a finding: an integer from 0 to 10, or nothing usable.
export const isPhaseNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= MIN_PHASE && value <= MAX_PHASE;
