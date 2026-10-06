// Records of the deterministic grep scanner. Field names are the snake_case keys the
// findings.jsonl artifacts carry; they are written to disk unchanged.

export type PatternDef = {
  pattern: string;
  rule: string;
  severity: string;
  category: string;
  description: string;
  phase: number;
  explanation: string;
  removable?: boolean;
  target_code?: string | null;
  confidence?: string;
  confidence_reason?: string;
  skip_import_lines?: boolean;
  skip_string_literals?: boolean;
  file_glob_excludes?: readonly string[];
  layer_exclude?: readonly string[];
  dormant?: boolean;
};

export type ScannerFinding = {
  rule: string;
  severity: string;
  category: string;
  file: string;
  line: number;
  end_line: number;
  snippet: string;
  current_code: string;
  description: string;
  explanation: string;
  search_pattern: string;
  target_code: string | null;
  target_import: null;
  fix_plan: null;
  phase: number;
  effort: string;
  layer: string;
  scanner: string;
  confidence: string;
  confidence_reason: string;
};

export type ScanResult = { findings: ScannerFinding[]; counters: Record<string, number> };
