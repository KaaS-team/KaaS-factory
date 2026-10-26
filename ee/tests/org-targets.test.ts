// SPDX-License-Identifier: LicenseRef-KaaS-EE
// The org gate checks the repo the handler acts on, never a different one the request also names,
// and the lists the dashboard opens on show a member only their own org's repos.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { orgsExtension } from "../plane/orgs";
import { cookieFor, plane } from "./plane";

const BASE = "http://localhost:4100";
const call = (p: ReturnType<typeof plane>, label: string, cookie: string, body?: unknown) => {
  const [method, path] = label.split(" ");
  return p.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    }),
  );
};

async function twoOrgs(planeRepo = "acme/widgets") {
  const p = plane([orgsExtension("acme/widgets")], { repo: planeRepo });
  p.store.setMember("boss", "owner", "test");
  const owner = cookieFor(p, "boss");
  for (const body of [
    { name: "red", repos: ["acme/widgets"] },
    { name: "blue", repos: ["blue/app"] },
  ])
    expect((await call(p, "POST /api/orgs", owner, body)).status).toBe(200);
  const member = { org: "blue", login: "bob", role: "operator" };
  expect((await call(p, "POST /api/orgs/members", owner, member)).status).toBe(200);
  return { p, owner, bob: cookieFor(p, "bob") };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_REPOS;
  process.env.FACTORY_REPOS = "acme/widgets,blue/app";
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_REPOS;
  else process.env.FACTORY_REPOS = saved;
});

describe("org mode targets", () => {
  test("a request naming two repos, or a repo that is not a string, gets a 400, and the gate checks the repo the handler acts on", async () => {
    const { p, bob } = await twoOrgs();
    const act = { action: "dismiss" };
    const status = async (label: string, body?: unknown) => (await call(p, label, bob, body)).status;
    expect(await status("POST /api/inbox/1/act?repo=blue/app", { ...act, repo: "acme/widgets" })).toBe(400);
    expect(await status("POST /api/inbox/1/act", { ...act, repo: ["blue/app"] })).toBe(400);
    expect(await status("POST /api/inbox/1/act?repo=blue/app", { ...act, repo: "blue/app" })).not.toBe(403);
    // The plane resolves one repo per request, so ?repo= on a body route is the repo it acts on:
    // bob's repo has nothing waiting, and the plane's own repo is one he cannot see: both 404.
    expect(await status("POST /api/inbox/1/act?repo=blue/app", act)).toBe(404);
    expect(await status("POST /api/inbox/1/act", act)).toBe(404);
    expect(await status("GET /api/runs?repo=blue/app")).toBe(200);
    expect(await status("GET /api/runs?repo=acme/widgets")).toBe(404);
    expect(await status("GET /api/analytics?repo=blue/app")).toBe(200);
    expect(await status("GET /api/issues/1/thread?repo=blue/app")).toBe(200);
    expect(await status("GET /api/issues/1/thread?repo=acme/widgets")).toBe(404);
  });

  test("the inbox and the line list a member's own org repos, and every repo for a plane owner", async () => {
    const { p, owner, bob } = await twoOrgs();
    const repos = async (label: string, cookie: string) => {
      const res = await call(p, label, cookie);
      expect(res.status).toBe(200);
      return ((await res.json()) as { repos: string[] }).repos;
    };
    expect(await repos("GET /api/inbox", bob)).toEqual(["blue/app"]);
    expect(await repos("GET /api/line", bob)).toEqual(["blue/app"]);
    expect(await repos("GET /api/inbox", owner)).toEqual(["acme/widgets", "blue/app"]);
    expect(await repos("GET /api/line", owner)).toEqual(["acme/widgets", "blue/app"]);
  });

  test("on a plane with no repo of its own, analytics counts only the runs of the caller's org repos", async () => {
    const { p, owner, bob } = await twoOrgs("");
    for (const [issue, repo] of [
      [1, "acme/widgets"],
      [2, "blue/app"],
      [3, "loose/repo"],
    ] as const)
      p.state.upsertRun({ issue, repo, title: "t", stage: "triage", status: "running" });
    const runs = async (cookie: string) => {
      const res = await call(p, "GET /api/analytics", cookie);
      return res.status === 200 ? ((await res.json()) as { runs: number }).runs : res.status;
    };
    // loose/repo is not one this plane serves, so even its owner's count leaves it out.
    expect(await runs(owner)).toBe(2);
    expect(await runs(bob)).toBe(1);
    const member = { org: "red", login: "bob", role: "viewer" };
    expect((await call(p, "POST /api/orgs/members", owner, member)).status).toBe(200);
    expect(await runs(bob)).toBe(2);
  });
});
