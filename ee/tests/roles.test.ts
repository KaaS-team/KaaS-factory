// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { describe, expect, test } from "bun:test";
import { rolesExtension } from "../plane/roles";
import { cookieFor, plane } from "./plane";

const BASE = "http://localhost:4100";
const call = (p: ReturnType<typeof plane>, label: string, cookie: string, body: unknown = {}) => {
  const [method, path] = label.split(" ");
  return p.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  );
};

describe("custom roles", () => {
  test("a custom role grants and denies single routes on top of its base, and never grants an owner route", async () => {
    const p = plane([rolesExtension()]);
    p.store.setMember("boss", "owner", "test");
    const owner = cookieFor(p, "boss");
    const define = (allow: string[], deny: string[]) =>
      call(p, "POST /api/roles", owner, { name: "release-manager", base: "viewer", allow, deny });
    expect((await define(["POST /api/issues/:n/merge", "POST /api/toggles"], ["GET /api/analytics"])).status).toBe(200);
    expect((await call(p, "POST /api/roles/assign", owner, { login: "rm", role: "release-manager" })).status).toBe(200);
    const rm = cookieFor(p, "rm");

    expect(await (await call(p, "GET /api/me", rm)).json()).toMatchObject({ login: "rm", role: "viewer", custom: "release-manager" });
    expect((await call(p, "GET /api/runs", rm)).status).toBe(200);
    expect([401, 403]).not.toContain((await call(p, "POST /api/issues/1/merge", rm)).status);
    expect((await call(p, "POST /api/tasks", rm)).status).toBe(403);
    expect((await call(p, "GET /api/analytics", rm)).status).toBe(403);
    expect((await call(p, "POST /api/toggles", rm)).status).toBe(403);
    expect((await call(p, "POST /api/roles", rm, { name: "x", base: "owner" })).status).toBe(403);

    // An edit applies on the next request, with no new sign-in.
    expect((await define([], ["POST /api/issues/:n/merge"])).status).toBe(200);
    expect((await call(p, "POST /api/issues/1/merge", rm)).status).toBe(403);
  });

  test("a role name cannot shadow a built-in one", async () => {
    const p = plane([rolesExtension()]);
    p.store.setMember("boss", "owner", "test");
    const res = await call(p, "POST /api/roles", cookieFor(p, "boss"), { name: "owner", base: "viewer" });
    expect(res.status).toBe(400);
  });
});
