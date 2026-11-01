import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_FILE,
  type LedgerRow,
  readLedger,
  recordFailure,
  recordFix,
  recordPass,
  writeLedger,
} from "../src/failure-ledger";

const F = "claim push ran the pre-push gate";
const statusOf = (rows: readonly LedgerRow[]) => rows.find((r) => r.failure === F)?.status;

function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "failure-ledger-"));
}

describe("failure ledger transitions", () => {
  test("a new failure opens with no fix, and a repeat keeps one row", () => {
    const rows = recordFailure(recordFailure([], F, 3), F, 5);
    expect(rows).toEqual([{ failure: F, fix: "", status: "open", failedRun: 5 }]);
  });

  test("a fix moves open to fixed and records the fix text", () => {
    const rows = recordFix(recordFailure([], F, 1), F, "#160");
    expect(rows).toEqual([{ failure: F, fix: "#160", status: "fixed", failedRun: 1 }]);
  });

  test("a pass verifies a fixed row only when its run is later than the failure", () => {
    const fixed = recordFix(recordFailure([], F, 4), F, "#160");
    expect(statusOf(recordPass(fixed, F, 4))).toBe("fixed");
    expect(statusOf(recordPass(fixed, F, 3))).toBe("fixed");
    expect(statusOf(recordPass(fixed, F, 5))).toBe("verified");
  });

  test("a pass never verifies an open row", () => {
    expect(statusOf(recordPass(recordFailure([], F, 1), F, 9))).toBe("open");
  });

  test("a verified failure that recurs is regressed, and a new fix returns it to fixed", () => {
    const verified = recordPass(recordFix(recordFailure([], F, 1), F, "#160"), F, 2);
    const regressed = recordFailure(verified, F, 3);
    expect(regressed).toEqual([{ failure: F, fix: "#160", status: "regressed", failedRun: 3 }]);
    expect(statusOf(recordFix(regressed, F, "#170"))).toBe("fixed");
  });

  test("a fixed failure that recurs reopens", () => {
    const fixed = recordFix(recordFailure([], F, 1), F, "#160");
    expect(statusOf(recordFailure(fixed, F, 2))).toBe("open");
  });

  test("other rows are left alone", () => {
    const other = "two watchers collide on port 4100";
    const rows = recordFix(recordFailure(recordFailure([], other, 1), F, 1), F, "#160");
    expect(rows.find((r) => r.failure === other)?.status).toBe("open");
  });
});

describe("failure ledger file", () => {
  test("an empty directory reads as no rows, and rows round trip through a nested directory", () => {
    const root = tmp();
    try {
      const dir = join(root, "a", "b");
      expect(readLedger(dir)).toEqual([]);
      const rows = recordFix(recordFailure([], F, 1), F, "#160");
      writeLedger(dir, rows);
      expect(readLedger(dir)).toEqual(rows);
      expect(existsSync(join(dir, `${LEDGER_FILE}.tmp`))).toBe(false);
      expect(readFileSync(join(dir, LEDGER_FILE), "utf8").endsWith("\n")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed file is refused rather than read as rows", () => {
    const root = tmp();
    try {
      writeFileSync(join(root, LEDGER_FILE), JSON.stringify([{ failure: F, fix: "", status: "done", failedRun: 1 }]));
      expect(() => readLedger(root)).toThrow("malformed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
