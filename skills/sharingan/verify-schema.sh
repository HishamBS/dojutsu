#!/usr/bin/env bash
# Automated schema verification — compares plan SQL against actual db.ts
# Usage: verify-schema.sh <plan-file> <db-file>
# Returns non-zero if columns are missing

set -euo pipefail

PLAN_FILE="${1:?Usage: verify-schema.sh <plan-file> <db-file>}"
DB_FILE="${2:?Usage: verify-schema.sh <plan-file> <db-file>}"
REPORT_FILE="${3:-/tmp/sharingan-schema-report.md}"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

if [[ ! -f "$DB_FILE" ]]; then
  echo "ERROR: DB file not found: $DB_FILE" >&2
  exit 1
fi

echo "## Schema Verification Report" > "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "Plan: $PLAN_FILE" >> "$REPORT_FILE"
echo "DB:   $DB_FILE" >> "$REPORT_FILE"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Extract CREATE TABLE blocks from plan (macOS + Linux compatible)
PLAN_TABLES=$(grep -E 'CREATE TABLE ' "$PLAN_FILE" 2>/dev/null | sed 's/.*CREATE TABLE //' | awk '{print $1}' | sort -u || true)
# Extract CREATE TABLE blocks from db.ts
DB_TABLES=$(grep -E 'CREATE TABLE IF NOT EXISTS ' "$DB_FILE" 2>/dev/null | sed 's/.*CREATE TABLE IF NOT EXISTS //' | awk '{print $1}' | sort -u || true)

MISSING_TABLES=0
MISSING_COLUMNS=0

for table in $PLAN_TABLES; do
  if ! echo "$DB_TABLES" | grep -q "^${table}$"; then
    echo "MISSING TABLE: $table" >> "$REPORT_FILE"
    MISSING_TABLES=$((MISSING_TABLES + 1))
  fi
done

# Extract column names from plan for each table
# This is a heuristic — looks for lines with column definitions inside CREATE TABLE blocks
while IFS= read -r table; do
  [[ -z "$table" ]] && continue

  # Get column names from plan for this table
  plan_cols=$(sed -n "/CREATE TABLE.*${table}/,/);/p" "$PLAN_FILE" 2>/dev/null | \
    grep -E '^\s+\w+\s+(TEXT|INTEGER|DATETIME|REAL|BLOB)' 2>/dev/null | \
    awk '{print $1}' | sort -u || true)

  # Get column names from db.ts for this table
  db_cols=$(sed -n "/CREATE TABLE.*${table}/,/\`/p" "$DB_FILE" 2>/dev/null | \
    grep -E '^\s+\w+\s+(TEXT|INTEGER|DATETIME|REAL|BLOB)' 2>/dev/null | \
    awk '{print $1}' | sort -u || true)

  for col in $plan_cols; do
    if ! echo "$db_cols" | grep -q "^${col}$"; then
      echo "MISSING COLUMN: ${table}.${col}" >> "$REPORT_FILE"
      MISSING_COLUMNS=$((MISSING_COLUMNS + 1))
    fi
  done
done <<< "$PLAN_TABLES"

echo "" >> "$REPORT_FILE"
echo "### Summary" >> "$REPORT_FILE"
echo "- Missing tables: $MISSING_TABLES" >> "$REPORT_FILE"
echo "- Missing columns: $MISSING_COLUMNS" >> "$REPORT_FILE"

if [[ $MISSING_TABLES -gt 0 ]] || [[ $MISSING_COLUMNS -gt 0 ]]; then
  echo "- Verdict: FAIL" >> "$REPORT_FILE"
  cat "$REPORT_FILE"
  exit 1
else
  echo "- Verdict: PASS" >> "$REPORT_FILE"
  cat "$REPORT_FILE"
  exit 0
fi
