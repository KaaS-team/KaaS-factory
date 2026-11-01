// An escaped defect (a revert or a reopened issue) opens exactly one follow-up issue.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { FOLLOW_UP_PREFIX, followUpIssue, newFollowUps, reopenedIn, revertsIn } from "../src/escaped-defect";

test("a follow-up issue is titled with the prefix and asks for a regression test", () => {
  const f = followUpIssue({
    kind: "revert",
    ref: "#12",
    why: "smoke failed",
    sha: "abc1234",
    link: "pr/1",
  });
  expect(f.title).toBe("Escaped defect: reverted #12");
  expect(f.title.startsWith(FOLLOW_UP_PREFIX)).toBe(true);
  expect(f.body).toContain("regression test that fails at the reverted change");
  expect(f.body).toContain("abc1234");
  expect(followUpIssue({ kind: "reopen", ref: "#3", why: "x" }).title).toBe("Escaped defect: reopened #3");
});

test("revertsIn finds the reverted sha and skips records with no revert line", () => {
  const sha = "a".repeat(40);
  const log = [
    `${"1".repeat(40)}\x00Revert "x"\x00This reverts commit ${sha}.\n`,
    `${"2".repeat(40)}\x00feat: y\x00plain body\n`,
    `${"3".repeat(40)}\x00fix: z\x00\n`,
  ].join("\x1e");
  expect(revertsIn(log)).toEqual([
    {
      kind: "revert",
      ref: "aaaaaaa",
      sha,
      why: 'reverted by 1111111: Revert "x"',
    },
  ]);
});

test("reopenedIn keeps reopened issues inside the window only", () => {
  const ev = (o: object) => ({
    event: "reopened",
    created_at: "2026-10-30T00:00:00Z",
    ...o,
  });
  const events = [
    ev({ issue: { number: 5, title: "bug" } }),
    ev({ issue: { number: 5, title: "bug" } }),
    ev({
      issue: { number: 6, title: "old" },
      created_at: "2026-10-01T00:00:00Z",
    }),
    ev({ issue: { number: 7, title: "x" }, event: "closed" }),
    ev({ issue: { number: 8, title: `${FOLLOW_UP_PREFIX} reverted #1` } }),
    "junk",
    null,
    ev({ issue: { number: "9", title: "bad" } }),
  ];
  expect(reopenedIn(events, "2026-10-29T00:00:00Z")).toEqual([{ kind: "reopen", ref: "#5", why: "reopened: bug" }]);
});

test("newFollowUps drops an existing title and a duplicate in the list", () => {
  const a = { kind: "revert" as const, ref: "aaaaaaa", why: "w" };
  const b = { kind: "reopen" as const, ref: "#5", why: "w" };
  expect(newFollowUps([a, a, b], [])).toEqual([a, b]);
  expect(newFollowUps([a, b], [followUpIssue(a).title])).toEqual([b]);
});

test("the nightly workflow runs the scan on a schedule with issues: write", () => {
  const file = [".github/workflows/escaped-defects.yml", "ci/escaped-defects.yml"].find(existsSync)!;
  const yml = readFileSync(file, "utf8");
  expect(yml).toContain("bun scripts/escaped-defects.ts");
  expect(yml).toContain("schedule:");
  expect(yml).toContain("issues: write");
});
