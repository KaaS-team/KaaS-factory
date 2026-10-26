// Checks API progress: each step is one GitHub check run on the issue branch, opened when the step
// starts and concluded when it ends. FACTORY_CHECKS_TOKEN turns it on; a step before the branch exists
// opens nothing.
import { afterAll, describe, expect, test } from "bun:test";
import type { CloudEvent } from "../src/core/event";
import { CHECKS_ENV, CheckProgress } from "../src/integrations/checks";
import { LinkStore } from "../src/integrations/links";
import { wireIntegrations } from "../src/integrations/wire";

const calls: { method: string; path: string; body: unknown }[] = [];
let branchExists = true;
const github = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "GET" ? undefined : await req.json();
    calls.push({ method: req.method, path, body });
    if (req.method === "GET")
      return branchExists ? Response.json({ sha: "abc123" }) : new Response("{}", { status: 404 });
    return Response.json({ id: 77 }, { status: req.method === "POST" ? 201 : 200 });
  },
});
afterAll(() => github.stop());
const env = { [CHECKS_ENV.token]: "ghs_x", GITHUB_API_URL: github.url.origin };
const ev = (type: string, step: string) =>
  ({
    specversion: "1.0",
    id: `${type}/${step}`,
    type,
    source: "f",
    subject: "issue/9",
    time: "t",
    data: { repo: "acme/shop", issue: 9, workflow: "default", step },
  }) as CloudEvent;

describe("Checks API progress", () => {
  test("a step opens one check run on the branch head and its end concludes that run", async () => {
    calls.length = 0;
    const subs: ((e: CloudEvent) => Promise<void>)[] = [];
    expect(
      wireIntegrations({
        subscribe: (_t, fn) => subs.push(fn),
        links: new LinkStore(":memory:"),
        stageRuns: () => [],
        env,
      }),
    ).toEqual(["github-checks"]);
    for (const e of [ev("factory.step.started", "verify"), ev("factory.step.failed", "verify")])
      for (const fn of subs) await fn(e);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/repos/acme/shop/commits/factory%2Fissue-9"],
      ["POST", "/repos/acme/shop/check-runs"],
      ["PATCH", "/repos/acme/shop/check-runs/77"],
    ]);
    expect(calls[1]!.body).toMatchObject({ name: "factory / verify", head_sha: "abc123", status: "in_progress" });
    expect(calls[2]!.body).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  test("a step that starts before the branch exists opens no check run", async () => {
    calls.length = 0;
    branchExists = false;
    const checks = new CheckProgress(github.url.origin, env);
    await checks.on(ev("factory.step.started", "triage"));
    await checks.on(ev("factory.step.completed", "triage"));
    branchExists = true;
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
