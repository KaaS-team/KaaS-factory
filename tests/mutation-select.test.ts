import { expect, test } from "bun:test";
import { shardPath } from "../scripts/mutation-list";
import { selectMutations } from "../scripts/mutation-select";

const all = [
  { name: "a", file: "src/a.ts", test: "tests/a.test.ts" },
  { name: "b", file: "src/b.ts", test: "tests/b.test.ts" },
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

test("a list edit runs only the entries that are new or changed against the base list", () => {
  const added = { name: "c", file: "src/c.ts", test: "tests/c.test.ts" };
  const edited = { ...all[1]!, test: "tests/b2.test.ts" };
  expect(selectMutations([...all, added], ["tests/mutations.json"], all)).toEqual([added]);
  expect(selectMutations([all[0]!, edited], ["tests/mutations.json"], all)).toEqual([edited]);
  expect(selectMutations(all, ["tests/mutations.json"], all)).toEqual([]);
  expect(selectMutations([...all, added], ["tests/mutations.json", "src/a.ts"], all)).toEqual([all[0]!, added]);
});

test("a changed per-entry file selects its entry, and a loader change selects everything", () => {
  expect(selectMutations(all, [shardPath("b")])).toEqual([all[1]!]);
  expect(selectMutations(all, ["scripts/mutation-list.ts"])).toHaveLength(2);
});

test("the pull request job passes the base ref so it runs the scoped set", () => {
  const yml = require("node:fs").readFileSync(".github/workflows/mutations.yml", "utf8") as string;
  expect(yml).toContain("--base origin/{0}");
  expect(yml).toContain("fetch-depth: 0");
});

test("an entry's inputs select it when the diff touches one of them", () => {
  const withInputs = { name: "a", file: "src/a.ts", test: "tests/a.test.ts", inputs: ["src/shared.ts"] };
  const without = { name: "b", file: "src/b.ts", test: "tests/b.test.ts" };
  expect(selectMutations([withInputs, without], ["src/shared.ts"])).toEqual([withInputs]);
});
