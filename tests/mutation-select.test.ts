import { expect, test } from "bun:test";
import { selectMutations } from "../scripts/mutation-select";

const all = [
  { file: "src/a.ts", test: "tests/a.test.ts" },
  { file: "src/b.ts", test: "tests/b.test.ts" },
];

test("a PR runs only the mutations whose file or test the diff touched", () => {
  expect(selectMutations(all, ["src/a.ts"])).toEqual([all[0]!]);
  expect(selectMutations(all, ["tests/b.test.ts"])).toEqual([all[1]!]);
  expect(selectMutations(all, ["README.md"])).toEqual([]);
});

test("a change to the runner or the list runs every mutation", () => {
  expect(selectMutations(all, ["tests/mutations.json"])).toHaveLength(2);
  expect(selectMutations(all, ["scripts/check-mutations.ts"])).toHaveLength(2);
});

test("the pull request job passes the base ref so it runs the scoped set", () => {
  const yml = require("node:fs").readFileSync(".github/workflows/mutations.yml", "utf8") as string;
  expect(yml).toContain("--base origin/{0}");
  expect(yml).toContain("fetch-depth: 0");
});
