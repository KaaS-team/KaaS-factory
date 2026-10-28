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
    {
      number: 1,
      url: "u1",
      state: "OPEN",
      headRefName: "factory/issue-5",
      isDraft: false,
      isCrossRepository: true,
      closingIssuesReferences: [{ number: 5 }],
    },
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

describe("GitHub.mergedPrByHead", () => {
  test("lists only merged PRs on the head, so one closed without merging never counts", async () => {
    const calls: string[][] = [];
    const gh = new GitHub({
      run: async (args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 4, url: "u", state: "MERGED", headRefName: "factory/issue-2", isDraft: false },
          ]),
          stderr: "",
        };
      },
    });
    expect((await gh.mergedPrByHead("o/r", "factory/issue-2"))?.number).toBe(4);
    expect(await gh.mergedPrByHead("o/r", "factory/issue-3")).toBeUndefined();
    expect(calls[0]).toEqual([
      "pr",
      "list",
      "--repo",
      "o/r",
      "--head",
      "factory/issue-2",
      "--state",
      "merged",
      "--json",
      "number,url,state,headRefName,isDraft,closingIssuesReferences",
      "--limit",
      "1",
    ]);
  });
});

describe("GitHub issue reads over REST", () => {
  const issue = {
    number: 7,
    title: "t",
    body: null,
    state: "open",
    labels: [{ name: "x" }],
    comments: 1,
    updated_at: "u1",
  };
  const comment = {
    id: 99,
    html_url: "https://github.com/o/r/issues/7#issuecomment-99",
    user: { login: "octo" },
    author_association: "MEMBER",
    body: "/factory approve",
    created_at: "2026-10-13T08:19:09Z",
  };
  const fake = () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const url = args.find((a) => a.startsWith("repos/")) ?? "";
      const out = url.includes("/comments")
        ? [[comment]]
        : url.endsWith("/issues/7")
          ? issue
          : [[issue, { ...issue, number: 8, pull_request: {} }]];
      return { code: 0, stdout: JSON.stringify(out), stderr: "" };
    };
    return { calls, gh: new GitHub({ run }) };
  };

  test("every reader gives each comment's author as its login, and never uses GraphQL", async () => {
    const { gh, calls } = fake();
    const reads = [
      (await gh.listIssuesByLabel("o/r", "x"))[0]!,
      (await gh.listOpenIssues("o/r"))[0]!,
      await gh.getIssue("o/r", 7),
    ];
    for (const i of reads) expect([i.comments[0]!.author, i.body, i.state]).toEqual(["octo", "", "OPEN"]);
    expect(calls.every((a) => a[0] === "api")).toBe(true);
  });

  test("a pull request is not an issue", async () => {
    expect((await fake().gh.listOpenIssues("o/r")).map((i) => i.number)).toEqual([7]);
  });

  test("comments are refetched only when the issue changed", async () => {
    const { gh, calls } = fake();
    await gh.listOpenIssues("o/r");
    await gh.listOpenIssues("o/r");
    expect(calls.filter((a) => a.some((x) => x.includes("/comments"))).length).toBe(1);
  });

  test("labels and comments are written through the REST API", async () => {
    const { gh, calls } = fake();
    await gh.addLabels("o/r", 7, ["a", "b"]);
    await gh.removeLabels("o/r", 7, ["a"]);
    await gh.commentIssue("o/r", 7, "hi");
    expect(calls.map((a) => a.slice(0, 4).join(" "))).toEqual([
      "api -X POST repos/o/r/issues/7/labels",
      "api -X DELETE repos/o/r/issues/7/labels/a",
      "api -X POST repos/o/r/issues/7/comments",
    ]);
  });
});
