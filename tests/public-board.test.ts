// Goal #323: the public read-only board is off by default, shows only the repos it is told to, and
// carries a number, a scrubbed title and a column per card, never a label, a risk or an operator field.

import { afterEach, describe, expect, test } from "bun:test";
import { createAccess } from "../dashboard/plane/access";
import { createDashboard } from "../dashboard/server";
import { PUBLIC_CARD_KEYS, PUBLIC_BOARD_ENV, PUBLIC_BOARD_ROUTE, publicRepos } from "../dashboard/public-board";
import { GitHub, type GhIssue } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";

const REPO = "acme/widgets";
const ISSUES: GhIssue[] = [
  {
    number: 7,
    title: "Swap claude-opus-5-5 in the docs for build-7.internal",
    body: "secret body",
    labels: [{ name: LABEL.building }, { name: "risk:high" }],
    comments: [],
  },
  { number: 8, title: "Rewrite the onboarding guide", body: "", labels: [{ name: LABEL.needsInfo }], comments: [] },
];

class Fake extends GitHub {
  override async listOpenIssues(): Promise<GhIssue[]> {
    return ISSUES;
  }
}

const saved = process.env[PUBLIC_BOARD_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[PUBLIC_BOARD_ENV];
  else process.env[PUBLIC_BOARD_ENV] = saved;
});

function dash() {
  return createDashboard(
    new FactoryState(":memory:"),
    new Fake(),
    REPO,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    createAccess({ token: "t0k" }),
  );
}
const open = (d: ReturnType<typeof dash>, path: string) =>
  d.handle(new Request(`http://box.local:4100${path}`), "203.0.113.9");

describe("public board", () => {
  test("is off by default: a 404 with the variable unset", async () => {
    delete process.env[PUBLIC_BOARD_ENV];
    const res = await open(dash(), "/public/board");
    expect(res.status).toBe(404);
  });

  test("a repo that is not named is a 404, a named one needs no token", async () => {
    process.env[PUBLIC_BOARD_ENV] = REPO;
    const d = dash();
    expect((await open(d, "/public/board/acme/other")).status).toBe(404);
    expect((await open(d, "/api/board?repo=acme/widgets")).status).toBe(401);
    const res = await open(d, "/public/board");
    expect(res.status).toBe(200);
  });

  test("each card holds only an issue number, a scrubbed title and a column", async () => {
    process.env[PUBLIC_BOARD_ENV] = REPO;
    const body = (await (await open(dash(), `/public/board/${REPO}`)).json()) as {
      repo: string;
      cards: Record<string, unknown>[];
    };
    expect(body.repo).toBe(REPO);
    expect(body.cards.map((c) => Object.keys(c).sort())).toEqual([
      [...PUBLIC_CARD_KEYS].sort(),
      [...PUBLIC_CARD_KEYS].sort(),
    ]);
    expect(body.cards.map((c) => c.column)).toEqual(["build", "attention"]);
    expect(body.cards[1]!.title).toBe("Rewrite the onboarding guide");
    const text = JSON.stringify(body);
    for (const leak of ["claude", "opus", "internal", "risk", "secret body", "needs-info"])
      expect(text).not.toContain(leak);
  });

  test("only well-formed owner/name entries count", () => {
    expect(publicRepos({ [PUBLIC_BOARD_ENV]: " a/b, nope ,c/d.e,,x/y/z" })).toEqual(["a/b", "c/d.e"]);
    expect(publicRepos({})).toEqual([]);
  });

  test("the route is on the public allow-list", async () => {
    const { PUBLIC_ROUTES } = await import("../dashboard/server");
    expect(PUBLIC_ROUTES).toContain(PUBLIC_BOARD_ROUTE);
  });
});
