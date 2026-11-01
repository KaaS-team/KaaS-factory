import { describe, expect, test } from "bun:test";
import { createClient, fakeClient } from "../src/api/client";
import { ROUTES, RUN_SCHEMA } from "../src/api/routes";
import { cmdServe } from "../src/api/serve-cli";
import { fitsSchema } from "../src/schemas";

describe("generated client", () => {
  test("fakeClient two-repos lists 3 runs", async () => {
    const { runs } = await fakeClient("two-repos").runs.list();
    expect(runs.length).toBe(3);
    for (const r of runs) {
      expect(fitsSchema(RUN_SCHEMA, r)).toBe(true);
      for (const key of RUN_SCHEMA.required as string[]) expect(key in r).toBe(true);
    }
    expect(runs.map((r) => r.status).sort()).toEqual(["awaiting-approval", "running", "shipped"]);
  });

  test("a method exists for every route id, and path params and errors work", async () => {
    const client = fakeClient("two-repos") as unknown as Record<string, Record<string, unknown> | unknown>;
    for (const route of ROUTES) {
      const [a, b] = route.id.split(".");
      const method = b ? (client[a!] as Record<string, unknown>)[b] : client[a!];
      expect(typeof method).toBe("function");
    }
    const c = fakeClient("two-repos");
    expect((await c.runs.get({ repo: "acme/web", issue: 7 })).run.title).toBe("Add dark mode");
    expect((await c.runs.events({ repo: "acme/web", issue: 7, after: 1 })).events.length).toBe(1);
    await expect(c.runs.get({ repo: "acme/web", issue: 999 })).rejects.toThrow("no such run");
  });

  test("a wrong token is refused", async () => {
    const c = createClient("http://fixture.invalid", "wrong", (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) =>
      (await import("../src/api/core"))
        .coreRoutes((await import("../src/api/fixtures")).fixture("two-repos"))
        .fetch(new Request(input as string, init))) as typeof fetch);
    expect((await c.health()).ok).toBe(true);
    await expect(c.runs.list()).rejects.toThrow("unauthorized");
  });
});

describe("factory serve", () => {
  test("factory serve with a fixture answers health", async () => {
    const args = ["serve", "--fixture", "two-repos", "--port", "0"];
    const flags = new Map([
      ["fixture", "two-repos"],
      ["port", "0"],
    ]);
    const server = await cmdServe({
      args,
      flag: (n) => flags.get(n),
      has: () => false,
      resolveCloneDir: async () => "",
      watchDeps: async () => ({}) as never,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(await res.json()).toEqual({ ok: true });
      expect((await fetch(`http://127.0.0.1:${server.port}/api/runs`)).status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
