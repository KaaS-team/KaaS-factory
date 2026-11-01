// Failure ledger (issue #164): every failure the swarm hits, its fix, and whether a later run proved the fix.
// Rows are keyed by failure text. Run ids are numbers that only grow. The caller owns the directory and the run ids.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_STATUSES = ["open", "fixed", "verified", "regressed"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerRow {
  readonly failure: string;
  readonly fix: string;
  readonly status: LedgerStatus;
  readonly failedRun: number; // the latest run that hit this failure
}

export const LEDGER_FILE = "failure-ledger.json";

const isRow = (r: unknown): r is LedgerRow => {
  const o = r as Record<string, unknown> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.failure === "string" &&
    typeof o.fix === "string" &&
    typeof o.failedRun === "number" &&
    LEDGER_STATUSES.includes(o.status as LedgerStatus)
  );
};

export function readLedger(dir: string): LedgerRow[] {
  const file = join(dir, LEDGER_FILE);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isRow)) throw new Error(`failure ledger ${file} is malformed`);
  return parsed;
}

export function writeLedger(dir: string, rows: readonly LedgerRow[]): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LEDGER_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
  renameSync(tmp, file);
}

const replaceRow = (rows: readonly LedgerRow[], failure: string, next: (r: LedgerRow) => LedgerRow): LedgerRow[] =>
  rows.map((r) => (r.failure === failure ? next(r) : r));

// A failure seen in a run. New failures open. A verified one that recurs is regressed.
// A fixed one that recurs reopens. An open or regressed one only records the newer run.
export function recordFailure(rows: readonly LedgerRow[], failure: string, run: number): LedgerRow[] {
  const row = rows.find((r) => r.failure === failure);
  if (!row) return [...rows, { failure, fix: "", status: "open", failedRun: run }];
  const status: LedgerStatus = row.status === "verified" ? "regressed" : row.status === "fixed" ? "open" : row.status;
  return replaceRow(rows, failure, (r) => ({ ...r, status, failedRun: Math.max(r.failedRun, run) }));
}

// Names the fix. An open or regressed row becomes fixed. A row already fixed or verified keeps its status.
export function recordFix(rows: readonly LedgerRow[], failure: string, fix: string): LedgerRow[] {
  return replaceRow(rows, failure, (r) => ({
    ...r,
    fix,
    status: r.status === "open" || r.status === "regressed" ? "fixed" : r.status,
  }));
}

// Only a fixed row, and only a passing run later than the last failure, becomes verified.
export function recordPass(rows: readonly LedgerRow[], failure: string, passingRun: number): LedgerRow[] {
  return replaceRow(rows, failure, (r) =>
    r.status === "fixed" && passingRun > r.failedRun ? { ...r, status: "verified" } : r,
  );
}
