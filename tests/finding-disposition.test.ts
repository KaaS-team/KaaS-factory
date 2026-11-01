// Each finding ends fixed, dismissed with a reason, or open; the id survives a moved line.
import { expect, test } from "bun:test";
import type { Finding } from "../src/artifacts";
import { dispositions, stableId, tally } from "../src/finding-disposition";

const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,2 +10,3 @@", " x", "+y", " z"].join("\n");
const f = (what: string, where?: string): Finding => ({ severity: "must", confidence: 4, what, where });

test("a finding whose lines the final diff changed is fixed, the other open", () => {
  const rows = dispositions([f("null deref", "src/a.ts:11"), f("leak", "src/b.ts:3")], diff, []);
  expect(rows.map((r) => r.disposition)).toEqual(["fixed", "open"]);
  expect(tally(rows)).toEqual({ found: 2, fixed: 1, dismissed: 0, open: 1 });
});

test("a dismissal with a reason dismisses an unfixed finding; a blank reason does not", () => {
  const finding = f("leak", "src/b.ts:3");
  const id = stableId(finding);
  expect(dispositions([finding], diff, [{ id, reason: "intended behaviour" }])[0]?.disposition).toBe("dismissed");
  expect(dispositions([finding], diff, [{ id, reason: "   " }])[0]?.disposition).toBe("open");
});

test("a finding moved down the file keeps one id; another file or text changes it", () => {
  expect(stableId(f("Leak ", "src/b.ts:10"))).toBe(stableId(f("leak", "src/b.ts:25-30")));
  expect(stableId(f("leak", "src/b.ts:10"))).not.toBe(stableId(f("leak", "src/c.ts:10")));
  expect(stableId(f("leak", "src/b.ts:10"))).not.toBe(stableId(f("other", "src/b.ts:10")));
});

test("a finding with no where is open unless dismissed; a string finding gets an id", () => {
  const bare = f("vague");
  const id = stableId(bare);
  expect(id.length).toBe(12);
  expect(dispositions([bare], diff, [])[0]?.disposition).toBe("open");
  expect(dispositions([bare], diff, [{ id, reason: "not a bug" }])[0]?.disposition).toBe("dismissed");
  expect(stableId("some text").length).toBe(12);
  expect(dispositions(["some text"], diff, [])[0]?.disposition).toBe("open");
});

test("a fixed finding stays fixed even with a dismissal, and an empty list tallies zero", () => {
  const finding = f("null deref", "src/a.ts:11");
  const rows = dispositions([finding], diff, [{ id: stableId(finding), reason: "x" }]);
  expect(rows[0]?.disposition).toBe("fixed");
  expect(tally([])).toEqual({ found: 0, fixed: 0, dismissed: 0, open: 0 });
});
