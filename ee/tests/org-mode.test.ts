// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { describe, expect, test } from "bun:test";
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
const refused = async (res: Promise<Response>) => [401, 403].includes((await res).status);

describe("org mode", () => {
  test("a role in one org reaches that org's repos only, and org settings stay with plane owners", async () => {
    const p = plane([orgsExtension("acme/widgets")]);
    p.store.setMember("boss", "owner", "test");
    const owner = cookieFor(p, "boss");
    const ok = async (label: string, body: unknown) => expect((await call(p, label, owner, body)).status).toBe(200);
    await ok("POST /api/orgs", { name: "red", repos: ["acme/widgets"] });
    await ok("POST /api/orgs", { name: "blue", repos: ["blue/app"] });
    await ok("POST /api/orgs/members", { org: "red", login: "alice", role: "operator" });
    await ok("POST /api/orgs/members", { org: "blue", login: "bob", role: "operator" });
    await ok("POST /api/orgs/members", { org: "red", login: "carol", role: "viewer" });
    // A plane-wide operator role does not lift carol above her org role.
    p.store.setMember("carol", "operator", "test");
    const [alice, bob, carol] = [cookieFor(p, "alice"), cookieFor(p, "bob"), cookieFor(p, "carol")];

    expect(await refused(call(p, "POST /api/tasks", alice, { title: "t" }))).toBe(false);
    expect(await refused(call(p, "GET /api/issues/1/thread?repo=blue/app", alice))).toBe(true);
    expect(await refused(call(p, "GET /api/issues/1/thread?repo=loose/repo", alice))).toBe(true);
    expect(await refused(call(p, "GET /api/runs", bob))).toBe(true);
    expect(await refused(call(p, "GET /api/issues/1/thread?repo=blue/app", bob))).toBe(false);
    // The target in a JSON body counts, so a write cannot slip past with no query string.
    expect(await refused(call(p, "POST /api/inbox/1/act", bob, { repo: "acme/widgets", action: "dismiss" }))).toBe(
      true,
    );
    expect(await refused(call(p, "POST /api/inbox/1/act", bob, { repo: "blue/app", action: "dismiss" }))).toBe(false);
    expect(await refused(call(p, "POST /api/tasks", carol, { title: "t" }))).toBe(true);
    expect(await refused(call(p, "GET /api/runs", carol))).toBe(false);

    expect(await refused(call(p, "GET /api/inbox?repo=blue/app", alice))).toBe(true);
    expect(await refused(call(p, "GET /api/inbox?repo=acme/widgets", alice))).toBe(false);
    expect(await refused(call(p, "GET /api/orgs", alice))).toBe(true);
    expect((await call(p, "GET /api/line", owner)).status).toBe(200);
    expect(await (await call(p, "GET /api/me", bob)).json()).toMatchObject({ login: "bob", role: "viewer" });

    // Leaving an org ends access to its repos on the next request.
    await ok("POST /api/orgs/members", { org: "red", login: "alice", role: null });
    expect(await refused(call(p, "GET /api/runs", alice))).toBe(true);
  });
});
