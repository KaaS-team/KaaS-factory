// Structural: every reason merge-policy.ts can refuse a merge for is a member
// of MergeRefusalReason (src/merge-policy.ts), and this test proves each one
// is exercised by name in its ported test file. A refusal reason added to the
// union with no matching test string fails here instead of shipping untested
// (plan v2.8.0: "every refusal branch has a test").

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = readFileSync(join(root, "src/merge-policy.ts"), "utf8");
const testSource = readFileSync(join(root, "tests/ported/machinist/merge-policy.test.ts"), "utf8");

const unionBody = /export type MergeRefusalReason =\n([\s\S]*?);\n/.exec(source);
if (!unionBody) throw new Error("MergeRefusalReason union not found in src/merge-policy.ts");
const reasons = [...unionBody[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);

test("MergeRefusalReason has at least the ten herdr checklist reasons", () => {
  expect(reasons.length).toBeGreaterThanOrEqual(10);
});

test("every MergeRefusalReason is asserted by name somewhere in tests/ported/machinist/merge-policy.test.ts", () => {
  for (const reason of reasons) expect(testSource, `"${reason}" has no test asserting it`).toContain(`"${reason}"`);
});
