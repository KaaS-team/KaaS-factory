import { afterEach, describe, expect, test } from "bun:test";
import { checkHealth, pickDeployment, teardownDue } from "../src/preview/health.js";
import { uiFacts } from "../src/visual.js";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
const serve = (handler: (n: number) => Response) => {
  let n = 0;
  const s = Bun.serve({ port: 0, fetch: () => handler(++n) });
  servers.push(s);
  return `http://localhost:${s.port}`;
};

describe("checkHealth", () => {
  test("one 200 then a 500 is not healthy", async () => {
    const url = serve((n) => new Response("x", { status: n === 1 ? 200 : 500 }));
    expect((await checkHealth(url, { path: "/", expectSha: "none", head: "abc" })).healthy).toBe(false);
  });
  test("two 200s are healthy", async () => {
    const url = serve(() => new Response("x"));
    expect((await checkHealth(url, { path: "/", expectSha: "none", head: "abc" })).healthy).toBe(true);
  });
  test("a header sha that differs from head is not healthy", async () => {
    const url = serve(() => new Response("x", { headers: { "x-commit-sha": "old" } }));
    const r = await checkHealth(url, { path: "/", expectSha: "header:x-commit-sha", head: "abc" });
    expect(r).toEqual({ healthy: false, sha: "old" });
  });
  test("a body sha equal to head is healthy", async () => {
    const url = serve(() => Response.json({ sha: "abc" }));
    expect((await checkHealth(url, { path: "/", expectSha: "body:sha", head: "abc" })).healthy).toBe(true);
  });
});

describe("pickDeployment", () => {
  const st = (state: string, createdAt: string, environmentUrl?: string) => ({
    state,
    createdAt,
    environmentUrl,
    logUrl: "log",
  });
  test("returns the head sha deployment and ignores other sha and environment", () => {
    const got = pickDeployment(
      [
        { sha: "old", environment: "preview/1", statuses: [st("success", "2026-01-02", "http://old")] },
        { sha: "abc", environment: "production", statuses: [st("success", "2026-01-03", "http://prod")] },
        { sha: "abc", environment: "preview/1", statuses: [st("success", "2026-01-01", "http://new")] },
      ],
      { head: "abc", environment: "preview" },
    );
    expect(got).toEqual({ environmentUrl: "http://new", logUrl: "log" });
  });
  test("a newer inactive status means none", () => {
    const got = pickDeployment(
      [
        {
          sha: "abc",
          environment: "preview",
          statuses: [st("success", "2026-01-01", "u"), st("inactive", "2026-01-02")],
        },
      ],
      { head: "abc", environment: "preview" },
    );
    expect(got === undefined).toBe(true);
  });
});

describe("teardownDue", () => {
  test("true on close, merge and ttl; false once torn down", () => {
    expect(teardownDue({ prState: "closed", ttlExpired: false, tornDown: false })).toBe(true);
    expect(teardownDue({ prState: "merged", ttlExpired: false, tornDown: false })).toBe(true);
    expect(teardownDue({ prState: "open", ttlExpired: true, tornDown: false })).toBe(true);
    expect(teardownDue({ prState: "open", ttlExpired: false, tornDown: false })).toBe(false);
    expect(teardownDue({ prState: "closed", ttlExpired: true, tornDown: true })).toBe(false);
  });
});

describe("uiFacts health", () => {
  const base = { pr: 1, baseline: "/nonexistent-a", current: "/nonexistent-b" };
  test("smoke follows the sha", async () => {
    const stale = serve(() => new Response("x", { headers: { "x-commit-sha": "old" } }));
    const fresh = serve(() => new Response("x", { headers: { "x-commit-sha": "abc" } }));
    const health = { path: "/", expectSha: "header:x-commit-sha", head: "abc" };
    expect((await uiFacts(["a.css"], { ...base, previewTemplate: stale, health })).smoke).toBe(false);
    expect((await uiFacts(["a.css"], { ...base, previewTemplate: fresh, health })).smoke).toBe(true);
  });
  test("without health the old smoke runs", async () => {
    const stale = serve(() => new Response("x", { headers: { "x-commit-sha": "old" } }));
    expect((await uiFacts(["a.css"], { ...base, previewTemplate: stale })).smoke).toBe(true);
  });
});
