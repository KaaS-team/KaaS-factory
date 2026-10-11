import { describe, expect, test } from "bun:test";
import { GitHub } from "../src/github";

describe("GitHub.editComment", () => {
  test("PATCHes the comment by id via the API (gh issue comment has no --edit <id>)", async () => {
    const calls: string[][] = [];
    const gh = new GitHub({
      run: async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await gh.editComment("o/r", 42, "hello");
    expect(calls).toEqual([["api", "-X", "PATCH", "repos/o/r/issues/comments/42", "-f", "body=hello"]]);
  });
});

describe("GitHub.listPrs", () => {
  const prs = [
    { number: 1, url: "u1", state: "OPEN", headRefName: "factory/issue-5", isDraft: false, isCrossRepository: true, closingIssuesReferences: [{ number: 5 }] },
    { number: 2, url: "u2", state: "OPEN", headRefName: "factory/issue-5", isDraft: false, isCrossRepository: false },
  ];
  const gh = () => new GitHub({ run: async () => ({ code: 0, stdout: JSON.stringify(prs), stderr: "" }) });

  test("ignores a fork PR that names a factory branch or closes a card", async () => {
    expect((await gh().listPrs("o/r")).map((p) => p.number)).toEqual([2]);
  });

  test("findPrByHead never returns the fork's PR", async () => {
    expect((await gh().findPrByHead("o/r", "factory/issue-5"))?.number).toBe(2);
  });
});
