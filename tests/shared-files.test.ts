import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parsePlannedIssue } from "../src/engine/import-plan";
import { SHARED_FILES, sharedClaims } from "../src/shared-files";

const root = `${import.meta.dir}/..`;
const base = Bun.file(`${root}/tests/fixtures/planned-issue.md`).text();

// Swap a file the fixture already lists for another path, in the task and in "## Files".
async function plan(path: string, extra = ""): Promise<string[]> {
  const body = (await base).replaceAll("`src/derive.ts`", `\`${path}\``);
  return parsePlannedIssue(extra ? `${body}\n${extra}\n` : body).problems;
}

test("a plan naming a shared file is rejected with the message", async () => {
  const problems = await plan("tests/mutations.json");
  expect(problems).toEqual([
    'names shared file `tests/mutations.json`; add a shard or a make/*.mk file instead, or excuse it with "Shared-ok: tests/mutations.json: <reason>".',
  ]);
});

test("a Shared-ok line with a reason excuses it", async () => {
  expect(await plan("tests/mutations.json", "Shared-ok: tests/mutations.json: migration")).toEqual([]);
});

test("a Shared-ok line without a reason does not excuse", async () => {
  for (const line of ["Shared-ok: tests/mutations.json:", "Shared-ok: tests/mutations.json:   "])
    expect((await plan("tests/mutations.json", line)).join("\n")).toContain("names shared file");
});

test("a plan listing only a shard file passes", async () => {
  expect(await plan("tests/mutations/example-shard.json")).toEqual([]);
});

test("sharedClaims returns only the unexcused shared paths", () => {
  expect(sharedClaims(["Makefile", "src/a.ts", "quality-baseline.json"], ["Shared-ok: Makefile: wiring"])).toEqual([
    "quality-baseline.json",
  ]);
});

// Add a path here, with the reason, when a shared file is deleted from the repo.
const RETIRED: Record<string, string> = {};

test("every shared file exists or is documented as retired", () => {
  for (const f of SHARED_FILES) expect(existsSync(`${root}/${f}`) || f in RETIRED).toBe(true);
});
