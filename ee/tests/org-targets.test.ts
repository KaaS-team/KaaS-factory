// SPDX-License-Identifier: LicenseRef-KaaS-EE
// The org gate checks the repo the handler acts on, never a different one the request also names,
// and the lists the dashboard opens on show a member only their own org's repos.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_REPO, orgsExtension, QUERY_REPO } from "../plane/orgs";
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
  test("a request naming two repos, or a repo that is not a string, gets a 400, and default-repo routes ignore ?repo", async () => {
    const { p, bob } = await twoOrgs();
    const act = { action: "dismiss" };
    const status = async (label: string, body?: unknown) => (await call(p, label, bob, body)).status;
    expect(await status("POST /api/inbox/1/act?repo=blue/app", { ...act, repo: "acme/widgets" })).toBe(400);
    expect(await status("POST /api/inbox/1/act", { ...act, repo: ["blue/app"] })).toBe(400);
    expect(await status("POST /api/inbox/1/act?repo=blue/app", { ...act, repo: "blue/app" })).not.toBe(403);
    // With no body repo the handler acts on the plane's own repo, so a query naming bob's repo is no key.
    expect(await status("POST /api/inbox/1/act?repo=blue/app", act)).toBe(403);
    expect(await status("GET /api/runs?repo=blue/app")).toBe(403);
    expect(await status("GET /api/analytics?repo=blue/app")).toBe(403);
    expect(await status("GET /api/issues/1/thread?repo=blue/app")).toBe(200);
    expect(await status("GET /api/issues/1/thread?repo=acme/widgets")).toBe(403);

    // The two sets name exactly the core routes whose handlers read a repo from the request.
    const server = readFileSync(join(import.meta.dir, "../../dashboard/server.ts"), "utf8");
    const reads = (needle: RegExp) =>
      server
        .split(/\n {4}\{\n/)
        .filter((block) => needle.test(block))
        .map((block) => /label: "([^"]+)"/.exec(block)?.[1]);
    expect(reads(/searchParams\.get\("repo"\)/).sort()).toEqual([...QUERY_REPO].sort());
    expect(reads(/body\.repo/).sort()).toEqual([...BODY_REPO].sort());
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
    expect(await runs(owner)).toBe(3);
    // bob's org owns blue/app alone; the plane's gate repo is red's, where he has no role.
    expect(await runs(bob)).toBe(403);
    const member = { org: "red", login: "bob", role: "viewer" };
    expect((await call(p, "POST /api/orgs/members", owner, member)).status).toBe(200);
    expect(await runs(bob)).toBe(2);
  });
});
