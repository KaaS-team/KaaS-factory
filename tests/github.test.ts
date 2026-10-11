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

describe("GitHub.mergedPrByHead", () => {
  test("lists only merged PRs on the head, so one closed without merging never counts", async () => {
    const calls: string[][] = [];
    const gh = new GitHub({
      run: async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: JSON.stringify([{ number: 4, url: "u", state: "MERGED", headRefName: "factory/issue-2", isDraft: false }]), stderr: "" };
      },
    });
    expect((await gh.mergedPrByHead("o/r", "factory/issue-2"))?.number).toBe(4);
    expect(await gh.mergedPrByHead("o/r", "factory/issue-3")).toBeUndefined();
    expect(calls[0]).toEqual([
      "pr", "list", "--repo", "o/r", "--head", "factory/issue-2", "--state", "merged",
      "--json", "number,url,state,headRefName,isDraft,closingIssuesReferences", "--limit", "1",
    ]);
  });
});
