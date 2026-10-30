import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Entry, MAX_DAYS, QUARANTINE_TAG, loadLedger, quarantineProblems, tagged } from "../scripts/quarantine";

const entry = (over: Partial<Entry> = {}): Entry => ({
  file: "tests/x.test.ts",
  test: `flips ${QUARANTINE_TAG}`,
  owner: "@someone",
  added: "2026-10-01",
  expires: "2026-10-20",
  issue: "#1",
  ...over,
});
const one = { file: "tests/x.test.ts", test: `flips ${QUARANTINE_TAG}` };
const today = "2026-10-10";

describe("quarantine ledger", () => {
  test("the real ledger and the real tree give no problems", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(quarantineProblems(loadLedger(), tagged(), today)).toEqual([]);
  });

  test("a valid entry for a tagged test is clean", () => {
    expect(quarantineProblems([entry()], [one], today)).toEqual([]);
  });

  test("a tagged test with no entry", () => {
    const [p] = quarantineProblems([], [one], today);
    expect(p).toContain("with no entry");
  });

  test("a stale entry", () => {
    expect(quarantineProblems([entry()], [], today)[0]).toContain("no longer tagged");
  });

  test("a missing owner", () => {
    expect(quarantineProblems([entry({ owner: "" })], [one], today)).toContain(
      `tests/x.test.ts "flips ${QUARANTINE_TAG}" has no owner`,
    );
  });

  test("an owner without @", () => {
    expect(quarantineProblems([entry({ owner: "someone" })], [one], today)[0]).toContain("must start with @");
  });

  test("a date that is not YYYY-MM-DD", () => {
    expect(quarantineProblems([entry({ expires: "next week" })], [one], today).join("\n")).toContain(
      "is not YYYY-MM-DD",
    );
  });

  test("an expiry past MAX_DAYS", () => {
    expect(quarantineProblems([entry({ added: "2026-10-01", expires: "2026-11-15" })], [one], today)[0]).toContain(
      `more than ${MAX_DAYS} days`,
    );
  });

  test("an expired entry names the file, the test and the date", () => {
    const [p] = quarantineProblems([entry({ expires: "2026-10-05" })], [one], today);
    expect(p).toContain("tests/x.test.ts");
    expect(p).toContain("flips");
    expect(p).toContain("2026-10-05");
    expect(p).toEndWith("fix it, delete it, or renew it with a new expiry");
  });

  test("tagged finds a tagged test call in a scratch tree", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/quarantine-`);
    writeFileSync(`${dir}/a.test.ts`, `test("plain", () => {});\nit("flips ${QUARANTINE_TAG}", () => {});\n`);
    expect(tagged(dir)).toEqual([{ file: `${dir}/a.test.ts`, test: `flips ${QUARANTINE_TAG}` }]);
  });
});

describe("Makefile filters on the tag", () => {
  const make = readFileSync("Makefile", "utf8");
  test("the test recipe's -t pattern rejects a tagged name and accepts a plain one", () => {
    const pattern = /bun test -t '([^']+)'/.exec(make.split("\ntest:\n")[1]!)![1]!;
    const re = new RegExp(pattern);
    expect(re.test(`flips ${QUARANTINE_TAG}`)).toBe(false);
    expect(re.test("a plain test")).toBe(true);
  });

  test("the quarantine recipe greps for the tag", () => {
    const recipe = make.split("\nquarantine:\n")[1]!.split("\n\n")[0]!;
    expect(recipe).toContain(`grep -rl ${QUARANTINE_TAG}`);
    expect(recipe).toContain(`-t ${QUARANTINE_TAG}`);
  });
});
