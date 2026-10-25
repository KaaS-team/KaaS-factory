// labels.ts must be the only place a `factory:*` label string is spelled
// out. Everything else imports LABEL.* (or STATE_LABELS/PARKED_LABELS).
// This is a structural test: it greps the tree rather than trusting a
// convention, so a new hardcoded label string fails the build.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE_DIRS = ["src", "bin", "dashboard"];
const LABEL_LITERAL =
  /"factory:(ready|triaging|planning|awaiting-approval|building|verifying|in-review|needs-info|needs-human|failed|monitor)"/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe("labels.ts is the only source of factory:* label strings", () => {
  for (const dir of SOURCE_DIRS) {
    const files = walk(join(ROOT, dir)).filter((f) => !f.endsWith(`${join("src", "labels.ts")}`));
    for (const file of files) {
      test(`${file.replace(`${ROOT}/`, "")} does not hardcode a label string`, () => {
        const text = readFileSync(file, "utf8");
        const matches = [...text.matchAll(LABEL_LITERAL)];
        expect(matches.map((m) => m[0])).toEqual([]);
      });
    }
  }

  test("LABEL's factory:* names are each defined exactly once", async () => {
    const { LABEL } = await import("../src/labels");
    const values = Object.values(LABEL);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test("LABELS is LABEL's factory:* names plus the five type labels, no more", async () => {
    const { LABEL, LABELS, TYPE_LABELS } = await import("../src/labels");
    expect(LABELS.length).toBe(Object.values(LABEL).length + TYPE_LABELS.length);
    const names = new Set(LABELS.map((l) => l.name));
    expect(names.size).toBe(LABELS.length);
  });
});
