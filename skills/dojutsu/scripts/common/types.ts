// Persisted records shared across the quality skills. Field names are the snake_case keys
// the Python-era artifacts already carry; they are written to disk unchanged.

export type InventoryFile = {
  path: string;
  loc: number;
  layer: string;
  tag: string;
  nominal: boolean;
  is_meta_file: boolean;
  skip_reason?: string;
};

export type InventoryLayer = { files: string[]; loc: number };

export type Inventory = {
  root: string;
  stack: string;
  framework: string;
  total_files: number;
  total_loc: number;
  layers: Record<string, InventoryLayer>;
  files: InventoryFile[];
};

export type ScanBatch = {
  id: number;
  layer: string;
  files: string[];
  status: string;
  output_file: string;
  finding_count: number;
};

export type ScanPlan = { total_batches: number; completed: number; batches: ScanBatch[] };

// One finding as the deterministic tools emit it: the findings.jsonl schema's scanner-side
// fields. Aggregation and enrichment add the optional ones.
export type Finding = {
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
  phase: number;
  effort: string;
  scanner: string;
  confidence: string;
  confidence_reason: string;
  tool_rule_id: string;
  cwe: string[];
  id?: string;
  layer?: string;
};
