import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/github";
import { outcomeReport } from "../src/outcomes";
import { readOutcomes } from "../src/outcomes-read";

const human = (body: string) => ({ author: { login: "dev" }, authorAssociation: "OWNER", body, createdAt: "t" });
const factory = (body: string) => ({
  author: { login: "bot" },
  authorAssociation: "OWNER",
  body: `${body}\n\n<!-- factory:data {"stage":"plan","json":{}} -->`,
  createdAt: "t",
});
const picked = (name: string) => ({
  author: { login: "bot" },
  authorAssociation: "OWNER",
  body: `Running workflow.\n\n<!-- factory:data {"stage":"workflow","json":{"name":"${name}"}} -->`,
  createdAt: "t",
});

const issue = (number: number, o: Record<string, unknown> = {}) => ({
  number,
  state: "CLOSED",
  stateReason: "COMPLETED",
  closedAt: "2026-10-10T00:00:00Z",
  labels: [{ name: "factory:ready" }],
  comments: [],
  ...o,
});

// A fixture history: every outcome state once, plus things that must not count.
const issues = [
  issue(1), // merged PR
  issue(2), // closed PR
  issue(3, { labels: [{ name: "factory:ready" }, { name: "team:api" }] }), // kept, no PR
  issue(4, { stateReason: "NOT_PLANNED" }), // dismissed, no PR
  issue(5, { comments: [factory("which db?"), human("sqlite")] }), // comment acted on
  issue(6, { comments: [factory("which db?")] }), // comment ignored
  issue(7, { state: "OPEN", closedAt: null, comments: [factory("still waiting")] }), // pending
  issue(8, { labels: [{ name: "bug" }] }), // not the factory's
  issue(10), // closed while its PR is still open: nothing settled yet
  issue(9, { comments: [picked("feature-to-pr__terse")] }), // variant, merged PR
];
const prs = [
  { number: 20, state: "OPEN", mergedAt: null, closedAt: null, closingIssuesReferences: [{ number: 10 }] },
  {
    number: 11,
    state: "MERGED",
    mergedAt: "2026-10-11T00:00:00Z",
    closedAt: "2026-10-11T00:00:00Z",
    closingIssuesReferences: [{ number: 1 }],
  },
  {
    number: 12,
    state: "CLOSED",
    mergedAt: null,
    closedAt: "2026-10-12T00:00:00Z",
    closingIssuesReferences: [{ number: 2 }],
  },
  {
    number: 19,
    state: "MERGED",
    mergedAt: "2026-10-13T00:00:00Z",
    closedAt: "2026-10-13T00:00:00Z",
    closingIssuesReferences: [{ number: 9 }],
  },
];
const runner: CommandRunner = {
  async run(args) {
    const data = args[0] === "issue" ? issues : prs;
    return { code: 0, stdout: JSON.stringify(data), stderr: "" };
  },
};
const costs: Record<number, number | null> = { 1: 2, 2: 3, 3: 1, 4: 1, 5: 4, 6: 5, 9: 6 };
const ledger = { costOf: (n: number) => costs[n] };

const read = () => readOutcomes(runner, "o/r", { defaultWorkflow: "feature-to-pr", ledger });
const pick = (o: Awaited<ReturnType<typeof read>>, kind: string, state: string) =>
  o.filter((x) => x.kind === kind && x.state === state);

describe("readOutcomes on a fixture history", () => {
  test("a merged PR and a PR closed unmerged are told apart", async () => {
    const o = await read();
    expect(pick(o, "pr", "merged").map((x) => x.cost_usd)).toEqual([2, 6]);
    expect(pick(o, "pr", "closed").map((x) => x.cost_usd)).toEqual([3]);
  });

  test("an issue with no PR is kept when completed and dismissed when not planned", async () => {
    const o = await read();
    // Issues 3, 5 and 6 are completed with no PR.
    expect(pick(o, "issue", "kept")).toHaveLength(3);
    expect(pick(o, "issue", "kept").map((x) => x.team)).toEqual(["api", "(none)", "(none)"]);
    expect(pick(o, "issue", "dismissed")).toHaveLength(1);
  });

  test("an issue with a PR is counted once, as its PR", async () => {
    const o = await read();
    // Issues 3 to 6 have no PR; 1, 2 and 9 do and add no issue outcome.
    expect(o.filter((x) => x.kind === "issue")).toHaveLength(4);
  });

  test("a factory comment is acted on when a human answered it and ignored when the thread closed unanswered", async () => {
    const o = await read();
    expect(pick(o, "comment", "acted")).toHaveLength(1);
    expect(pick(o, "comment", "ignored")).toHaveLength(1);
  });

  test("an open thread, a non-factory issue and the workflow marker comment produce no outcome", async () => {
    const o = await read();
    expect(o).toHaveLength(9);
    expect(o.filter((x) => x.kind === "comment")).toHaveLength(2);
  });

  test("an issue whose PR is still open settles nothing", async () => {
    const o = await read();
    expect(o).toHaveLength(9);
  });

  test("an item's cost sits on one outcome, so the totals match the ledger", async () => {
    const r = outcomeReport(await read());
    expect(r.workflows.reduce((n, g) => n + (g.cost_usd ?? 0), 0)).toBe(22);
  });

  test("the workflow a trusted comment recorded names the variant, and the report compares it", async () => {
    const o = await read();
    expect(pick(o, "pr", "merged").map((x) => x.workflow)).toEqual(["feature-to-pr", "feature-to-pr__terse"]);
  });

  test("a failing gh call is an error, not an empty report", async () => {
    const bad: CommandRunner = { run: async () => ({ code: 1, stdout: "", stderr: "no auth" }) };
    await expect(readOutcomes(bad, "o/r", { defaultWorkflow: "w", ledger })).rejects.toThrow("no auth");
  });
});
