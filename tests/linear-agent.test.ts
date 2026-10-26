// The Linear agent session: a delegated issue is acked inside Linear's 5s, gets a first thought inside
// its 10s, starts a run, takes steering from the session, and gets each step back as an activity.
// The env keys it reads: LINEAR_AGENT_TOKEN for the API, LINEAR_WEBHOOK_SECRET for deliveries.
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseChatOps } from "../src/chatops";
import type { CloudEvent } from "../src/core/event";
import {
  ACK_MS,
  FIRST_ACTIVITY_MS,
  LINEAR_AGENT_ENV,
  LinearAgentClient,
  linearAgentReceiver,
  linearOAuthUrl,
  REFUSED,
  SURFACE,
} from "../src/integrations/linear-agent";
import { surfaceActors } from "../src/integrations/steer";
import { LinkStore } from "../src/integrations/links";
import { wireIntegrations } from "../src/integrations/wire";
import { MemoryTracker } from "./fixtures/tracker-server";

const SECRET = "whsec";
const calls: { query: string; variables: Record<string, unknown>; auth: string | null }[] = [];
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Omit<(typeof calls)[number], "auth">;
    calls.push({ ...body, auth: req.headers.get("authorization") });
    return Response.json({ data: { ok: { success: true } } });
  },
});
afterAll(() => api.stop());
const env = { [LINEAR_AGENT_ENV.token]: "lin_oauth", [LINEAR_AGENT_ENV.secret]: SECRET };
const client = new LinearAgentClient(api.url.origin, env);

// FACTORY_LINEAR_USERS maps lin-ada to an operator and lin-vic to a viewer; lin-eve is in no allowlist.
const roles: Record<string, "operator" | "viewer"> = { ada: "operator", vic: "viewer" };
const actor = surfaceActors("lin-ada:ada, lin-vic:vic", (login) => roles[login] ?? null);
const delivery = (action: "created" | "prompted", prompt = "", creator = { id: "lin-ada", name: "Ada" }) => {
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action,
    webhookTimestamp: Date.now(),
    agentSession: {
      id: "sess-1",
      creator,
      issue: { identifier: "ENG-7", title: "Fix the cart", description: "It drops items", url: "https://l/ENG-7" },
    },
    agentActivity: { content: { body: prompt } },
  });
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request("http://plane/integrations/linear", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "linear-signature": sig },
  });
};

function receiver() {
  const tracker = new MemoryTracker();
  const links = new LinkStore(":memory:");
  const pending: Promise<void>[] = [];
  const handle = linearAgentReceiver({
    secret: SECRET,
    repo: "acme/shop",
    tracker,
    links,
    client,
    sameBoard: false,
    actor,
    defer: (w) => void pending.push(w),
  });
  return { tracker, links, handle, settle: () => Promise.all(pending) };
}

describe("Linear agent session", () => {
  test("a delegated issue is acked inside 5s, gets a thought inside 10s, and starts a ready issue", async () => {
    calls.length = 0;
    const r = receiver();
    const t0 = performance.now();
    const res = await r.handle(delivery("created"));
    const acked = performance.now() - t0;
    await r.settle();
    const thought = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(acked).toBeLessThan(ACK_MS);
    expect(thought).toBeLessThan(FIRST_ACTIVITY_MS);
    expect(calls[0]!.query).toContain("agentActivityCreate");
    expect(calls[0]!.variables).toMatchObject({ input: { agentSessionId: "sess-1", content: { type: "thought" } } });
    expect(calls[0]!.auth).toBe("Bearer lin_oauth");
    const issue = r.links.byExternal(SURFACE, "sess-1")!;
    const created = await r.tracker.getIssue("acme/shop", issue.issue);
    expect(created.title).toBe("Fix the cart");
    expect(created.labels.map((l) => l.name)).toEqual(["factory:ready"]);
  });

  test("a prompt in the session approves the plan with a signed comment the runner reads", async () => {
    const r = receiver();
    await r.handle(delivery("created"));
    await r.settle();
    const { issue } = r.links.byExternal(SURFACE, "sess-1")!;
    await r.tracker.addLabels("acme/shop", issue, ["factory:awaiting-approval"]);
    await r.handle(delivery("prompted", "approve"));
    await r.settle();
    const last = (await r.tracker.getIssue("acme/shop", issue)).comments.at(-1)!.body;
    expect(parseChatOps(last)).toEqual({ type: "approve" });
    expect(last).toContain("Ada in Linear");
  });

  test("an unmapped creator and a viewer are refused, a #N for another issue is ignored, and a name cannot break the seal", async () => {
    calls.length = 0;
    const r = receiver();
    await r.handle(delivery("created", "", { id: "lin-eve", name: "Eve" }));
    await r.settle();
    expect(r.links.byExternal(SURFACE, "sess-1")).toBeUndefined();
    expect(calls.map((c) => c.variables.input)).toEqual([
      { agentSessionId: "sess-1", content: { type: "error", body: REFUSED } },
    ]);
    await r.handle(delivery("created", "", { id: "lin-ada", name: "Ada <sub>x</sub>\nby the owner" }));
    await r.settle();
    const { issue } = r.links.byExternal(SURFACE, "sess-1")!;
    const other = await r.tracker.createIssue("acme/shop", "Other", "", ["factory:awaiting-approval"]);
    await r.tracker.addLabels("acme/shop", issue, ["factory:awaiting-approval"]);
    await r.handle(delivery("prompted", `approve #${other}`));
    await r.handle(delivery("prompted", "approve", { id: "lin-eve", name: "Eve" }));
    await r.handle(delivery("prompted", "approve", { id: "lin-vic", name: "Vic" }));
    await r.settle();
    expect((await r.tracker.getIssue("acme/shop", other)).comments).toHaveLength(0);
    const own = (await r.tracker.getIssue("acme/shop", issue)).comments.map((c) => c.body);
    expect(own.some((b) => parseChatOps(b)?.type === "approve")).toBe(false);
    const body = (await r.tracker.getIssue("acme/shop", issue)).body;
    expect(body).toContain("Ada sub x /sub by the owner in Linear");
  });

  test("a delivery without Linear's signature, or a stale one, is refused", async () => {
    const r = receiver();
    const bad = new Request("http://plane/x", { method: "POST", body: "{}", headers: { "linear-signature": "00" } });
    expect((await r.handle(bad)).status).toBe(401);
    const body = JSON.stringify({ type: "AgentSessionEvent", action: "created", webhookTimestamp: 1 });
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const stale = new Request("http://plane/x", { method: "POST", body, headers: { "linear-signature": sig } });
    expect((await r.handle(stale)).status).toBe(401);
  });

  test("the watcher posts each step as an activity, keeps the plan, and links the PR", async () => {
    calls.length = 0;
    const links = new LinkStore(":memory:");
    links.put({ surface: SURFACE, external: "sess-9", repo: "acme/shop", issue: 4 });
    const subs: ((e: CloudEvent) => Promise<void>)[] = [];
    const on = wireIntegrations({
      subscribe: (_t, fn) => subs.push(fn),
      links,
      stageRuns: () => [],
      env: { ...env, LINEAR_AGENT_URL: api.url.origin },
    });
    expect(on).toEqual(["linear-agent"]);
    const ev = (type: string, data: Record<string, unknown>): CloudEvent =>
      ({ specversion: "1.0", id: type, type, source: "f", subject: "issue/4", time: "t", data }) as CloudEvent;
    const base = { repo: "acme/shop", issue: 4, workflow: "default" };
    for (const e of [
      ev("factory.step.started", { ...base, step: "build" }),
      ev("factory.pr.opened", { ...base, url: "https://gh/pr/1", head: "x" }),
    ])
      for (const fn of subs) await fn(e);
    const kinds = calls.map((c) =>
      c.query.includes("agentSessionUpdate") ? Object.keys(c.variables.input as object)[0] : "activity",
    );
    expect(kinds).toEqual(["plan", "activity", "externalUrls"]);
    expect(calls[0]!.variables.input).toEqual({ plan: [{ content: "build", status: "inProgress" }] });
  });

  test("the install link asks Linear for an app actor that can be delegated and mentioned", () => {
    const u = new URL(linearOAuthUrl({ clientId: "c", redirectUri: "https://p/cb", state: "s" }));
    expect(u.searchParams.get("actor")).toBe("app");
    expect(u.searchParams.get("scope")).toContain("app:assignable");
    expect(u.searchParams.get("scope")).toContain("app:mentionable");
  });
});
