// Structural: every label that needs a human maps to exactly one inbox kind with
// at least one action, and no in-flight label does. A new parked or waiting
// state that is not added to WAITING fails here instead of going unseen.

import { describe, expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";
import type { GhIssue } from "../src/github";
import {
  InboxError,
  inboxPositionals,
  parkReasons,
  type InboxChannel,
  type InboxAction,
  WAITING,
  WAITING_LABELS,
  act,
  buildInbox,
  commandText,
} from "../src/inbox";
import { LABELS, LABEL, PARKED_LABELS, STATE_LABELS } from "../src/labels";

const at = (n: number) => `2026-09-2${n}T10:00:00Z`;
function issue(number: number, label: string, body = "<!-- factory:plan v1 -->\nThe plan", when = at(1)): GhIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [{ name: label }, { name: "bug" }],
    comments: [{ id: number, author: "op", authorAssociation: "OWNER", body, createdAt: when }],
  };
}

describe("inbox structure", () => {
  test("WAITING covers exactly the parked labels plus awaiting-approval and in-review", () => {
    expect(Object.keys(WAITING).sort()).toEqual([...WAITING_LABELS].sort());
    for (const p of PARKED_LABELS) expect(WAITING[p]).toBeDefined();
  });

  test("every factory state or parked label yields one item with actions, or none for in-flight labels", () => {
    const inFlight = new Set<string>([
      LABEL.ready,
      LABEL.blocked,
      LABEL.triaging,
      LABEL.planning,
      LABEL.building,
      LABEL.verifying,
    ]);
    for (const l of LABELS.filter((x) => x.category === "state" || x.category === "parked")) {
      const items = buildInbox([issue(1, l.name)]);
      if (inFlight.has(l.name)) expect(items, l.name).toHaveLength(0);
      else {
        expect(items, l.name).toHaveLength(1);
        expect(items[0]!.actions.length, l.name).toBeGreaterThan(0);
      }
    }
    expect(STATE_LABELS.filter((s) => !inFlight.has(s) && !WAITING[s])).toEqual([]);
  });

  test("every action is a command the trust parser recognises", () => {
    for (const { actions } of Object.values(WAITING)) {
      for (const a of actions) {
        const parsed = parseChatOps(commandText(a, "some words"));
        expect(parsed.type).toBe(a);
      }
    }
  });
});

describe("buildInbox", () => {
  test("a parked item leads with the runner's park reason, not the older plan comment", () => {
    const reasons = parkReasons([
      { issue: 4, status: "needs-human", reason: "verify uncertain" },
      { issue: 5, status: "shipped", reason: "stale" },
    ]);
    const [parked] = buildInbox([issue(4, LABEL.needsHuman)], reasons);
    expect(parked!.ask).toBe("Parked: verify uncertain\n\nThe plan");
    expect(buildInbox([issue(5, LABEL.needsHuman)], reasons)[0]!.ask).toBe("The plan");
    expect(buildInbox([issue(4, LABEL.awaitingApproval)], reasons)[0]!.ask).toBe("The plan");
  });

  test("orders the longest-waiting item first, strips markers and control codes, and caps the ask", () => {
    const items = buildInbox([
      issue(2, LABEL.failed, '<!-- factory:data {"stage":"build"} -->\n\x1b[31mBuild broke\x1b[0m', at(3)),
      issue(1, LABEL.awaitingApproval, `<!-- factory:plan v1 -->\n${"x".repeat(5000)}`, at(2)),
    ]);
    expect(items.map((i) => i.issue)).toEqual([1, 2]);
    expect(items[0]!.ask.length).toBe(1200);
    expect(items[1]!.ask).toBe("Build broke");
    expect(items[1]!.kind).toBe("failed");
  });

  test("pages past one screen: 250 waiting issues all appear", () => {
    const many = Array.from({ length: 250 }, (_, i) => issue(i + 1, LABEL.needsHuman));
    expect(buildInbox(many)).toHaveLength(250);
  });

  test("an in-review PR with a merge-policy dry-run comment gets its own kind, not the generic review-pr", () => {
    const items = buildInbox([
      issue(3, LABEL.inReview, "<!-- factory:merge-policy:abc123 -->\nMerge policy: **dry-run** — would auto-merge."),
    ]);
    expect(items[0]!.kind).toBe("merge-dry-run");
  });

  test("an in-review PR with no merge-policy comment keeps the generic review-pr kind", () => {
    const items = buildInbox([issue(3, LABEL.inReview, "<!-- factory:plan v1 -->\nready for review")]);
    expect(items[0]!.kind).toBe("review-pr");
  });
});

describe("act", () => {
  const item = { issue: 7, kind: "approve-plan" as const, actions: WAITING[LABEL.awaitingApproval]!.actions };
  test("posts the same comment a human would type", async () => {
    const posted: string[] = [];
    const github = { commentIssue: async (_r: string, _n: number, body: string) => (posted.push(body), 1) };
    expect(await act(github, "o/r", item, "approve")).toBe("/factory approve");
    expect(await act(github, "o/r", item, "revise", " cover zero ")).toBe("/factory revise cover zero");
    expect(posted).toEqual(["/factory approve", "/factory revise cover zero"]);
  });
  test("refuses an action the item does not offer, and text-less revise or answer", async () => {
    const github = { commentIssue: async () => 1 };
    await expect(act(github, "o/r", item, "retry")).rejects.toThrow(InboxError);
    await expect(act(github, "o/r", item, "revise", "  ")).rejects.toThrow(/needs text/);
    const q = { issue: 8, kind: "answer-question" as const, actions: WAITING[LABEL.needsInfo]!.actions };
    await expect(act(github, "o/r", q, "answer", "")).rejects.toThrow(/needs text/);
  });
  test("an answer is posted as plain text, not a command", async () => {
    const posted: string[] = [];
    const q = { issue: 8, kind: "answer-question" as const, actions: WAITING[LABEL.needsInfo]!.actions };
    await act({ commentIssue: async (_r, _n, b) => (posted.push(b), 1) }, "o/r", q, "answer", "USD only");
    expect(posted).toEqual(["USD only"]);
    expect(parseChatOps("USD only").type).toBe("answer");
  });
});

describe("ChatOps commands, structurally", () => {
  const ACTIONS: InboxAction[] = ["approve", "revise", "answer", "retry", "cancel"];

  test("every action round-trips through the parser, and every command the parser knows is offered somewhere", () => {
    for (const a of ACTIONS) expect(parseChatOps(commandText(a, "words")).type, a).toBe(a);
    const offered = new Set(Object.values(WAITING).flatMap((w) => w.actions));
    for (const a of ACTIONS) expect(offered.has(a), `${a} is offered by no waiting state`).toBe(true);
  });

  test("a command typed in a comment is only a command when it starts the comment", () => {
    for (const a of ["approve", "retry", "cancel"] as const)
      expect(parseChatOps(`please /factory ${a}`).type).toBe("answer");
  });
});

describe("inbox CLI arguments", () => {
  test("positionals skip flags with their values and --json", () => {
    expect(inboxPositionals(["inbox"])).toEqual([]);
    expect(inboxPositionals(["inbox", "12", "revise", "--text", "smaller"])).toEqual(["12", "revise"]);
    expect(inboxPositionals(["inbox", "--repo", "a/b", "--json", "7", "approve"])).toEqual(["7", "approve"]);
  });
});

describe("InboxChannel", () => {
  test("a channel receives items and replies through act, so the trust rule is shared", async () => {
    const seen: number[] = [];
    const channel: InboxChannel = { name: "fake", send: async (items) => void seen.push(...items.map((i) => i.issue)) };
    const items = buildInbox([issue(5, LABEL.awaitingApproval)]);
    await channel.send(items);
    expect(seen).toEqual([5]);
    const posted: string[] = [];
    expect(
      await act({ commentIssue: async (_r, _n, body) => (posted.push(body), 1) }, "a/b", items[0]!, "approve"),
    ).toBe("/factory approve");
    expect(posted).toEqual(["/factory approve"]);
  });
});
