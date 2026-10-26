// One risk object per task: the runner floors the plan's own rating from the files alone, package
// owners and protected paths raise it, and the board, the inbox and the badge all show that object.
import type { Risk } from "../src/artifacts";
import { expect, test } from "bun:test";
import { buildBoard } from "../dashboard/board";
import { riskBadge } from "../dashboard/public/lib/risk-badge.js";
import { createDashboard } from "../dashboard/server";
import { configProblems } from "../src/config";
import { factRefusals, type PrFacts } from "../src/pr-facts";
import { GitHub } from "../src/github";
import { LABEL } from "../src/labels";
import type { GhIssue } from "../src/ports/scm";
import { floorPlanRisk, riskObject } from "../src/risk";
import { FactoryState } from "../src/state";

const marker = (stage: string, json: unknown) => `<!-- factory:data ${JSON.stringify({ stage, json })} -->`;
const issue: GhIssue = {
  number: 5,
  title: "Add a column",
  body: "",
  labels: [{ name: LABEL.awaitingApproval }],
  comments: [
    {
      id: 1,
      author: "bot",
      authorAssociation: "OWNER",
      body: marker("plan", { risk: "low", files: ["db/migrations/0002.sql"] }),
      createdAt: "2026-10-01T00:00:00Z",
    } as never,
  ],
};

class Issues extends GitHub {
  override async listOpenIssues() {
    return [issue];
  }
  override async listPrs() {
    return [];
  }
}

test("one risk object per task reaches the board, the inbox and the badge", async () => {
  const card = buildBoard([issue])[0]!;
  expect(card.risk?.level).toBe("high");
  expect(card.risk?.plan).toBe("low");
  const d = createDashboard(new FactoryState(":memory:"), new Issues(), "acme/widgets", false, "/nonexistent");
  const inbox = (await (await d.handle(new Request("http://localhost:4100/api/inbox"), "127.0.0.1")).json()) as {
    items: { issue: number; risk: unknown }[];
  };
  const board = (await (await d.handle(new Request("http://localhost:4100/api/board"), "127.0.0.1")).json()) as {
    cards: { risk: unknown }[];
  };
  expect(inbox.items.find((i) => i.issue === 5)?.risk).toEqual(card.risk);
  expect(board.cards[0]!.risk).toEqual(card.risk);
  const h = (tag: string, attrs: Record<string, string>, text: string) => ({ tag, attrs, text });
  expect(riskBadge(h, card.risk)).toEqual({
    tag: "span",
    attrs: { class: "risk-badge risk-high", title: expect.stringContaining("db/migrations/0002.sql") },
    text: "high risk",
  });
  expect(riskBadge(h, null)).toBeNull();
});

test("a plan the agent rates lower than its files is raised to the deterministic rating", () => {
  const o = { protectedPaths: ["secrets/**"] };
  expect(floorPlanRisk({ risk: "low" as Risk, files: ["db/migrations/1.sql"] }, o).risk).toBe("high");
  expect(floorPlanRisk({ risk: "low" as Risk, files: [".github/workflows/ci.yml"] }, o).risk).toBe("high");
  expect(floorPlanRisk({ risk: "low" as Risk, files: ["secrets/key.ts"] }, o).risk).toBe("high");
  expect(
    floorPlanRisk({ risk: "low" as Risk, files: Array.from({ length: 11 }, (_, i) => `docs/${i}.md`) }, o).risk,
  ).toBe("medium");
  expect(floorPlanRisk({ risk: "low" as Risk, files: ["docs/a.md"] }, o).risk).toBe("low");
  // A higher rating from the agent always stands.
  expect(floorPlanRisk({ risk: "high", files: ["docs/a.md"] }, o).risk).toBe("high");
});

test("a package's owners and protected paths make a change under it high risk, and a full merge waits for a person", () => {
  const packages = [
    { path: "packages/billing", gates: [], owners: ["@finance"], protectedPaths: ["ledger/**"] },
    { path: "packages/web", gates: [] },
  ];
  expect(configProblems({ repo: "o/r", packages })).toEqual([]);
  expect(configProblems({ repo: "o/r", packages: [{ path: "p", gates: [], owners: "me" }] })).not.toEqual([]);
  const rate = (files: string[]) =>
    riskObject({ risk: "low" }, { risk: "low", files }, { protectedPaths: [], packages });
  expect(rate(["packages/web/a.ts"]).level).toBe("low");
  const owned = rate(["packages/billing/api.ts"]);
  expect(owned.level).toBe("high");
  expect(owned.blastRadius.owners).toEqual(["@finance"]);
  const guarded = rate(["packages/billing/ledger/post.ts"]);
  expect(guarded.blastRadius.protected).toEqual(["packages/billing/ledger/post.ts"]);
  const facts = { risk: owned, tamper: [], ui: { changed: false } } as unknown as PrFacts;
  expect(factRefusals(facts, "full").map((r) => r.detail)).toContain("5: needs an owner: @finance");
});
