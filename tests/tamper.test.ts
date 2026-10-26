// The tamper check fails a diff that passes the gate by weakening it, and verify's facts carry it.
import { expect, test } from "bun:test";
import { factRefusals, type PrFacts } from "../src/pr-facts";
import { tamperHits } from "../src/tamper";

const diff = (path: string, lines: string, extra = "") =>
  `diff --git a/${path} b/${path}\n${extra}--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n${lines}\n`;

test("a diff that weakens tests, runner config or skips fails the tamper check", () => {
  expect(tamperHits(diff("tests/a.test.ts", '-test("adds", () => {\n+test.skip("adds", () => {'))).toContain(
    "tests/a.test.ts: adds a skip marker",
  );
  expect(tamperHits(diff("tests/a_test.py", "+@pytest.mark.skip(reason='slow')"))).toContain(
    "tests/a_test.py: adds a skip marker",
  );
  expect(tamperHits(diff("tests/b.test.ts", "-  expect(sum(1, 2)).toBe(3);"))).toContain(
    "tests/b.test.ts: removes 1 assertions",
  );
  expect(tamperHits(diff("tests/c.test.ts", "-x", "deleted file mode 100644\n"))).toContain(
    "tests/c.test.ts: test file deleted",
  );
  expect(tamperHits(diff("vitest.config.ts", "+  exclude: ['**']"))).toContain(
    "vitest.config.ts: runner config changed",
  );
  expect(tamperHits(diff(".factory/gates.sh", "+exit 0"))).toEqual([
    ".factory/gates.sh: runner config changed",
    ".factory/gates.sh: forces a zero exit",
  ]);
  expect(tamperHits(diff("package.json", '-  "test": "bun test",\n+  "test": "true",'))).toContain(
    "package.json: the test script changed",
  );
  // A real fix with a new assertion is clean.
  expect(
    tamperHits(
      diff("src/sum.ts", "-  return a - b;\n+  return a + b;") +
        diff("tests/sum.test.ts", "+  expect(sum(1, 2)).toBe(3);"),
    ),
  ).toEqual([]);
  const facts = {
    tamper: ["tests/a.test.ts: adds a skip marker"],
    risk: { blastRadius: { owners: [], protected: [] }, level: "low" },
    ui: {},
  } as unknown as PrFacts;
  expect(factRefusals(facts, "semi").map((r) => r.detail)).toContain(
    "2: the diff weakens the proof: tests/a.test.ts: adds a skip marker",
  );
});
