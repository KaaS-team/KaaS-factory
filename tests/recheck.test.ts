import { expect, test } from "bun:test";
import type { Finding } from "../src/artifacts";
import { changedLines, DiffAnchorRechecker, hasBlocking, keepSupported } from "../src/recheck";

const f = (severity: Finding["severity"], what: string, confidence = 4): Finding => ({ severity, confidence, what });

test("keepSupported drops only unsupported must/should findings and ignores bad indexes", () => {
  const all: (string | Finding)[] = ["plain note", f("must", "a"), f("could", "nit"), f("should", "b")];
  const { kept, dropped } = keepSupported(all, [1, 99, -1, 1.5]);
  expect(dropped.map((d) => d.what)).toEqual(["a"]);
  expect(kept).toEqual(["plain note", all[2]!, all[3]!]);
});

test("hasBlocking needs a must/should finding at blocking confidence", () => {
  expect(hasBlocking([f("must", "x", 2), f("could", "y", 5), "s"])).toBe(false);
  expect(hasBlocking([f("should", "x", 3)])).toBe(true);
});

// A two-file diff: a.ts changes lines 10-14 (new side), b.ts is new (1-3), gone.ts is deleted.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@ export function a() {",
  " ctx",
  "-old",
  "+++ looks like a header but is an added line",
  "+new",
  " ctx",
  " ctx",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,3 @@",
  "+one",
  "+two",
  "+three",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
].join("\n");

const at = (where?: string): Finding => ({ severity: "must", confidence: 4, what: "w", ...(where ? { where } : {}) });

test("changedLines reads each file's new-side hunk ranges and skips deleted files", () => {
  expect([...changedLines(DIFF)]).toEqual([
    ["src/a.ts", [[10, 14]]],
    ["src/b.ts", [[1, 3]]],
  ]);
});

test("a finding is supported only when its where overlaps a changed hunk", async () => {
  const findings = [
    at("src/a.ts:12"), // inside the hunk
    at("./src/b.ts:3 (new file)"), // leading ./ and trailing prose
    at("src/a.ts:5-11"), // a range that overlaps
    at("src/a.ts:40"), // same file, outside every hunk
    at("src/c.ts:1"), // a file the diff never touched
    at("src/a.ts"), // no line
    at(), // no where at all
    at("src/gone.ts:1"), // a deleted file has no new side
  ];
  expect(await new DiffAnchorRechecker().supported(findings, DIFF)).toEqual([0, 1, 2]);
});
