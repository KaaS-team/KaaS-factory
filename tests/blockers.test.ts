import { describe, expect, test } from "bun:test";
import { blockerNumbers, resolveBlockers } from "../src/blockers";
import { LABEL } from "../src/labels";
import { baseIssue, FakeGitHub } from "./harness";

describe("blockerNumbers", () => {
  test("none means no blockers", () => {
    expect(blockerNumbers("Spec: x · Epic: #1 · Blocked by: none")).toEqual([]);
  });

  test("a missing line means no blockers", () => {
    expect(blockerNumbers("just a body, no blocked-by line")).toEqual([]);
  });

  test("one number", () => {
    expect(blockerNumbers("Blocked by: #86")).toEqual([86]);
  });

  test("several numbers, comma separated", () => {
    expect(blockerNumbers("Blocked by: #86, #87, #100")).toEqual([86, 87, 100]);
  });

  test("other text on the line around the numbers is ignored", () => {
    expect(blockerNumbers("Spec: docs/x.md · Epic: #82 · Blocked by: #86, #87")).toEqual([86, 87]);
  });

  test("a PR reference still counts", () => {
    expect(blockerNumbers("Blocked by: PR #81")).toEqual([81]);
  });
});

describe("resolveBlockers", () => {
  test("an issue with no blockers is clear immediately", async () => {
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [github.issues.get(1)!], []);
    expect(clear.map((i) => i.number)).toEqual([1]);
  });

  test("an open blocker demotes ready to blocked and comments once", async () => {
    const blocker = baseIssue(2, []);
    const issue = { ...baseIssue(1, [LABEL.ready]), body: "Blocked by: #2" };
    const github = new FakeGitHub([issue, blocker]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [issue], []);
    expect(clear).toEqual([]);
    expect(github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.blocked]);
    expect(github.issues.get(1)!.comments).toHaveLength(1);
  });

  test("a blocker closed as completed clears it", async () => {
    const blocker = { ...baseIssue(2, []), state: "CLOSED" as const, stateReason: "COMPLETED" };
    const issue = { ...baseIssue(1, [LABEL.ready]), body: "Blocked by: #2" };
    const github = new FakeGitHub([issue, blocker]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [issue], []);
    expect(clear.map((i) => i.number)).toEqual([1]);
  });

  test("a blocker closed as not planned still blocks", async () => {
    const blocker = { ...baseIssue(2, []), state: "CLOSED" as const, stateReason: "NOT_PLANNED" };
    const issue = { ...baseIssue(1, [LABEL.ready]), body: "Blocked by: #2" };
    const github = new FakeGitHub([issue, blocker]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [issue], []);
    expect(clear).toEqual([]);
  });

  test("a blocker that no longer exists still blocks (never build on an unverifiable reference)", async () => {
    const issue = { ...baseIssue(1, [LABEL.ready]), body: "Blocked by: #999" };
    const github = new FakeGitHub([issue]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [issue], []);
    expect(clear).toEqual([]);
  });

  test("several blockers all must be closed-completed before the issue clears", async () => {
    const a = { ...baseIssue(2, []), state: "CLOSED" as const, stateReason: "COMPLETED" };
    const b = baseIssue(3, []); // still open
    const issue = { ...baseIssue(1, [LABEL.ready]), body: "Blocked by: #2, #3" };
    const github = new FakeGitHub([issue, a, b]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [issue], []);
    expect(clear).toEqual([]);
    expect(github.issues.get(1)!.comments[0]!.body).toContain("#3");
    expect(github.issues.get(1)!.comments[0]!.body).not.toContain("#2");
  });

  test("a blocked issue promotes back to ready once its blocker clears", async () => {
    const blocker = { ...baseIssue(2, []), state: "CLOSED" as const, stateReason: "COMPLETED" };
    const issue = { ...baseIssue(1, [LABEL.blocked]), body: "Blocked by: #2" };
    const github = new FakeGitHub([issue, blocker]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [], [issue]);
    expect(clear.map((i) => i.number)).toEqual([1]);
    expect(clear[0]!.labels.map((l) => l.name)).toEqual([LABEL.ready]);
    expect(github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.ready]);
  });

  test("a still-blocked issue stays out of the clear list with no repeat comment", async () => {
    const issue = { ...baseIssue(1, [LABEL.blocked]), body: "Blocked by: #2" };
    const blocker = baseIssue(2, []);
    const github = new FakeGitHub([issue, blocker]);
    const { clear } = await resolveBlockers(github, "acme/widgets", [], [issue]);
    expect(clear).toEqual([]);
    expect(github.issues.get(1)!.comments).toEqual([]);
  });
});
