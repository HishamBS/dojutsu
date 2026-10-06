#!/usr/bin/env bun
// Usage: grep-scanner.ts <project_dir> <audit_dir>
// Deterministic grep-based scanner: finds every mechanical violation exhaustively, in
// seconds. The LLM scanners add their findings on top.
import { formatSummary, getPatternsForStack, loadInventory, scanProject, writeResults } from "@rinnegan/grep_scanner_lib.ts";

if (import.meta.main) {
  const [projectDir, auditDir] = process.argv.slice(2);
  if (projectDir === undefined || auditDir === undefined) {
    console.error("Usage: grep-scanner.ts <project_dir> <audit_dir>");
    process.exit(1);
  }
  const { sourceFiles, stack, fileToLayer } = loadInventory(auditDir);
  const { findings, counters } = scanProject(projectDir, sourceFiles, stack, fileToLayer);
  writeResults(auditDir, findings, sourceFiles);
  console.log(formatSummary(findings, getPatternsForStack(stack).length, sourceFiles.length, counters));
}
