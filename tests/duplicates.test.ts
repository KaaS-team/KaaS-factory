import { describe, expect, test } from "bun:test";
import { filesOf, likelyDuplicate, reconcileDuplicates, supersededBy, titleWords } from "../src/duplicates";
import { LABEL } from "../src/labels";
import { baseIssue, FakeGitHub } from "./harness";

const files = (...f: string[]) => `## Files\n${f.map((x) => `- \`${x}\``).join("\n")}\n`;
const a = { title: "Add retry to the webhook sender", body: files("src/a.ts", "src/b.ts") };

describe("likelyDuplicate", () => {
  test("equal files and five shared words is a duplicate", () => {
    expect(
      likelyDuplicate(a, { title: "Webhook sender retry add the thing", body: files("src/b.ts", "src/a.ts") }),
    ).toBe(true);
  });
  test("one file fewer is not", () => {
    expect(likelyDuplicate(a, { title: a.title, body: files("src/a.ts") })).toBe(false);
  });
  test("three shared words is not", () => {
    expect(likelyDuplicate(a, { title: "Add retry webhook", body: a.body })).toBe(false);
  });
  test("no Files section is never a duplicate", () => {
    const n = { title: a.title, body: "nothing" };
    expect(likelyDuplicate(n, n)).toBe(false);
    expect(filesOf(n.body)).toEqual([]);
  });
  test("titleWords drops short words", () => {
    expect([...titleWords("An Add to X1 go")]).toEqual(["add"]);
  });
});

describe("supersededBy", () => {
  test("reads both phrasings", () => {
    expect(supersededBy("Superseded by #5")).toBe(5);
    expect(supersededBy("x\nduplicate of #12")).toBe(12);
    expect(supersededBy("nothing")).toBeUndefined();
  });
});

describe("reconcileDuplicates", () => {
  const repo = "acme/widgets";
  test("closes an issue whose replacement shipped, once", async () => {
    const issue = { ...baseIssue(9, [LABEL.ready]), body: "Superseded by #5" };
    const done = { ...baseIssue(5, []), state: "CLOSED" as const, stateReason: "COMPLETED" };
    const github = new FakeGitHub([issue, done]);
    expect(await reconcileDuplicates(github, repo, [issue])).toEqual([9]);
    expect(github.issues.get(9)!.comments.map((c) => c.body)).toEqual(["Shipped in #5."]);
    expect(github.closed).toEqual([9]);
  });
  test("leaves it alone while the replacement is open", async () => {
    const issue = { ...baseIssue(9, [LABEL.ready]), body: "Superseded by #5" };
    const github = new FakeGitHub([issue, baseIssue(5, [])]);
    expect(await reconcileDuplicates(github, repo, [issue])).toEqual([]);
    expect(github.closed).toEqual([]);
  });
  test("parks a likely duplicate with one comment across polls", async () => {
    const first = { ...baseIssue(3, []), title: a.title, body: a.body };
    const dup = { ...baseIssue(8, [LABEL.ready]), title: a.title, body: a.body };
    const github = new FakeGitHub([first, dup]);
    expect(await reconcileDuplicates(github, repo, [dup])).toEqual([8]);
    expect(github.issues.get(8)!.labels.map((l) => l.name)).toEqual([LABEL.needsInfo]);
    const again = { ...github.issues.get(8)!, labels: [{ name: LABEL.ready }] };
    await reconcileDuplicates(github, repo, [again]);
    expect(github.issues.get(8)!.comments).toHaveLength(1);
  });
  test("makes no call when nothing is ready", async () => {
    const github = new FakeGitHub([]);
    github.listOpenIssues = async () => {
      throw new Error("called");
    };
    expect(await reconcileDuplicates(github, repo, [])).toEqual([]);
  });
});
