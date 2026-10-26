// A Slack assistant thread starts a task and steers it; the watcher answers in the same thread.
// The env keys it reads: SLACK_BOT_TOKEN for the Web API, SLACK_SIGNING_SECRET for deliveries.
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseChatOps } from "../src/chatops";
import { LinkStore } from "../src/integrations/links";
import { REFUSED, SLACK_ENV, SlackClient, slackProgress, slackReceiver, SURFACE } from "../src/integrations/slack";
import { surfaceActors } from "../src/integrations/steer";
import { MemoryTracker } from "./fixtures/tracker-server";

const SECRET = "slack-signing";
const calls: { method: string; body: Record<string, unknown> }[] = [];
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    calls.push({ method: new URL(req.url).pathname.slice(1), body: (await req.json()) as never });
    return Response.json({ ok: true });
  },
});
afterAll(() => api.stop());
const client = new SlackClient(api.url.origin, { [SLACK_ENV.token]: "xoxb-1", [SLACK_ENV.secret]: SECRET });

const now = 1_800_000_000;
const signed = (payload: unknown, ts = String(now)) => {
  const body = JSON.stringify(payload);
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("http://plane/integrations/slack", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
  });
};
const message = (text: string, user = "U42") => ({
  type: "event_callback",
  event: { type: "message", channel: "D1", thread_ts: "171.5", ts: "171.9", user, text },
});
// FACTORY_SLACK_USERS maps U42 to an operator and U7 to a viewer; U99 is in no allowlist.
const ROLES: Record<string, "operator" | "viewer"> = { ada: "operator", vic: "viewer" };
const actor = surfaceActors("U42:ada, U7:vic", (login) => ROLES[login] ?? null);

function receiver() {
  const tracker = new MemoryTracker();
  const links = new LinkStore(":memory:");
  const pending: Promise<void>[] = [];
  const handle = slackReceiver({
    secret: SECRET,
    repo: "acme/shop",
    tracker,
    links,
    client,
    actor,
    defer: (w) => void pending.push(w),
    nowS: () => now,
  });
  return { tracker, links, handle, settle: () => Promise.all(pending) };
}

describe("Slack assistant thread", () => {
  test("a message starts a ready issue, and approve in the same thread steers it", async () => {
    calls.length = 0;
    const r = receiver();
    expect((await r.handle(signed(message("start: Fix the cart\nIt drops items")))).status).toBe(200);
    await r.settle();
    const { issue } = r.links.byExternal(SURFACE, "D1:171.5")!;
    const created = await r.tracker.getIssue("acme/shop", issue);
    expect([created.title, created.labels.map((l) => l.name)]).toEqual(["Fix the cart", ["factory:ready"]]);
    expect(calls.map((c) => c.method)).toEqual(["assistant.threads.setStatus", "chat.postMessage"]);
    expect(calls[1]!.body).toMatchObject({ channel: "D1", thread_ts: "171.5", text: `Started #${issue}.` });

    await r.tracker.addLabels("acme/shop", issue, ["factory:needs-info"]);
    await r.handle(signed(message("It is the checkout page")));
    await r.settle();
    const last = (await r.tracker.getIssue("acme/shop", issue)).comments.at(-1)!.body;
    expect(parseChatOps(last)).toEqual({ type: "answer", text: "It is the checkout page" });
  });

  test("an unmapped user's start and a viewer's approve are refused, and a #N for another issue is ignored", async () => {
    calls.length = 0;
    const r = receiver();
    await r.handle(signed(message("start: Fix the cart", "U99")));
    await r.settle();
    expect(r.links.byExternal(SURFACE, "D1:171.5")).toBeUndefined();
    expect(calls.map((c) => c.body.text)).toEqual([REFUSED]);
    await r.handle(signed(message("start: Fix the cart")));
    await r.settle();
    const { issue } = r.links.byExternal(SURFACE, "D1:171.5")!;
    await r.tracker.addLabels("acme/shop", issue, ["factory:awaiting-approval"]);
    const other = await r.tracker.createIssue("acme/shop", "Other", "", ["factory:awaiting-approval"]);
    const before = (await r.tracker.getIssue("acme/shop", issue)).comments.length;
    for (const [text, user] of [
      ["approve", "U99"],
      ["approve", "U7"],
      [`approve #${other}`, "U42"],
    ] as const)
      await r.handle(signed(message(text, user)));
    await r.settle();
    expect((await r.tracker.getIssue("acme/shop", issue)).comments).toHaveLength(before);
    expect((await r.tracker.getIssue("acme/shop", other)).comments).toHaveLength(0);
  });

  test("an unsigned or replayed delivery is refused, and the URL check echoes its challenge", async () => {
    const r = receiver();
    const forged = new Request("http://p/x", { method: "POST", body: "{}", headers: { "x-slack-signature": "v0=0" } });
    expect((await r.handle(forged)).status).toBe(401);
    expect((await r.handle(signed(message("x"), String(now - 600)))).status).toBe(401);
    const ok = await r.handle(signed({ type: "url_verification", challenge: "abc" }));
    expect(await ok.json()).toEqual({ challenge: "abc" });
  });

  test("the bot's own messages never steer", async () => {
    calls.length = 0;
    const r = receiver();
    await r.handle(signed({ type: "event_callback", event: { ...message("approve").event, bot_id: "B1" } }));
    await r.settle();
    expect(calls).toEqual([]);
  });

  test("the watcher shows the running step as the thread's status and replies with the rest", async () => {
    calls.length = 0;
    const base = { repo: "acme/shop", issue: 3, done: false } as const;
    await slackProgress(client, "D1:171.5", { ...base, kind: "action", text: "Running build", step: "build" });
    await slackProgress(client, "D1:171.5", { ...base, kind: "link", text: "Pull request", url: "https://gh/pr/2" });
    expect(calls.map((c) => [c.method, c.body.status ?? c.body.text])).toEqual([
      ["assistant.threads.setStatus", "is running build"],
      ["assistant.threads.setStatus", ""],
      ["chat.postMessage", "Pull request: https://gh/pr/2"],
    ]);
  });
});
