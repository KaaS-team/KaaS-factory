// The GitHub webhook: HMAC first, one row per delivery, and the watcher polls
// as soon as a row lands.

import { afterEach, describe, expect, test } from "bun:test";
import { createDashboard } from "../dashboard/server";
import { GitHub, type GhIssue, type GhPr } from "../src/github";
import { mergeConfig } from "../src/config";
import { FactoryState } from "../src/state";
import { startWatch } from "../src/watch";
import { readDelivery, signatureMatches, signatureOf, WEBHOOK_SECRET_ENV } from "../src/webhook";

const SECRET = "s3cret-for-tests";
const enc = (s: string) => new TextEncoder().encode(s);

describe("signatureMatches", () => {
  const body = enc('{"zen":"Keep it logically awesome."}');
  test("accepts GitHub's sha256= HMAC of the raw body", () => {
    expect(signatureMatches(SECRET, body, signatureOf(SECRET, body))).toBe(true);
  });
  test.each([
    ["another secret", signatureOf("other", body)],
    ["a changed body", signatureOf(SECRET, enc('{"zen":"x"}'))],
    ["no header", null],
    ["the bare hex", signatureOf(SECRET, body).slice(7)],
    ["sha1", `sha1=${"0".repeat(40)}`],
  ])("refuses %s", (_name, header) => {
    expect(signatureMatches(SECRET, body, header)).toBe(false);
  });
  test("an empty secret never matches", () => {
    expect(signatureMatches("", body, signatureOf("", body))).toBe(false);
  });
});

describe("readDelivery", () => {
  const h = (id: string, event: string) => new Headers({ "x-github-delivery": id, "x-github-event": event });
  test("reads id, event, action and repo", () => {
    expect(
      readDelivery(h("72d3162e-cc78-11e3-81ab-4c9367dc0958", "issues"), {
        action: "labeled",
        repository: { full_name: "acme/widgets" },
      }),
    ).toEqual({
      id: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "issues",
      action: "labeled",
      repo: "acme/widgets",
    });
  });
  test("refuses a malformed id or event", () => {
    expect(readDelivery(h("", "issues"), {})).toBeUndefined();
    expect(readDelivery(h("a b", "issues"), {})).toBeUndefined();
    expect(readDelivery(h("abc", "Issues;DROP"), {})).toBeUndefined();
  });
});

class Gh extends GitHub {
  polls = 0;
  override async listPrs(): Promise<GhPr[]> {
    this.polls++;
    return [];
  }
  override async listIssuesByLabel(): Promise<GhIssue[]> {
    return [];
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [];
  }
}

async function dashboardWith(secret: string | undefined) {
  const before = process.env[WEBHOOK_SECRET_ENV];
  if (secret === undefined) delete process.env[WEBHOOK_SECRET_ENV];
  else process.env[WEBHOOK_SECRET_ENV] = secret;
  const state = new FactoryState(":memory:");
  const dashboard = createDashboard(state, new Gh(), "acme/widgets", false, "/nonexistent");
  return {
    state,
    dashboard,
    restore: () =>
      before === undefined ? delete process.env[WEBHOOK_SECRET_ENV] : (process.env[WEBHOOK_SECRET_ENV] = before),
  };
}

let restore = () => {};
afterEach(() => restore());

function delivery(body: object, opts: { id?: string; event?: string; secret?: string; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  return new Request("http://factory.example:4100/webhook/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": opts.id ?? "d-1",
      "x-github-event": opts.event ?? "issues",
      "x-hub-signature-256": opts.sig ?? signatureOf(opts.secret ?? SECRET, raw),
    },
    body: raw,
  });
}
const labeled = { action: "labeled", repository: { full_name: "acme/widgets" }, label: { name: "factory:ready" } };
const OFF_BOX = "203.0.113.7";

describe("POST /webhook/github", () => {
  test("is off (404) until FACTORY_WEBHOOK_SECRET is set", async () => {
    const d = await dashboardWith(undefined);
    restore = d.restore;
    expect((await d.dashboard.handle(delivery(labeled), "127.0.0.1")).status).toBe(404);
  });

  test("a signed delivery from off the box records one row, with no dashboard token needed", async () => {
    const d = await dashboardWith(SECRET);
    restore = d.restore;
    const res = await d.dashboard.handle(delivery(labeled), OFF_BOX);
    expect(res.status).toBe(201);
    expect(d.state.latestDelivery()).toBe(1);
  });

  test("a bad signature is 401 and records nothing", async () => {
    const d = await dashboardWith(SECRET);
    restore = d.restore;
    expect((await d.dashboard.handle(delivery(labeled, { secret: "guess" }), OFF_BOX)).status).toBe(401);
    expect((await d.dashboard.handle(delivery(labeled, { sig: "" }), OFF_BOX)).status).toBe(401);
    expect(d.state.latestDelivery()).toBe(0);
  });

  test("a redelivery of the same id is recorded once", async () => {
    const d = await dashboardWith(SECRET);
    restore = d.restore;
    await d.dashboard.handle(delivery(labeled, { id: "same" }), OFF_BOX);
    expect((await d.dashboard.handle(delivery(labeled, { id: "same" }), OFF_BOX)).status).toBe(200);
    expect(d.state.latestDelivery()).toBe(1);
  });

  test("another repo's event, an event that moves nothing, and ping are not recorded", async () => {
    const d = await dashboardWith(SECRET);
    restore = d.restore;
    expect(
      (await d.dashboard.handle(delivery({ ...labeled, repository: { full_name: "evil/fork" } }, { id: "a" }), OFF_BOX))
        .status,
    ).toBe(202);
    expect((await d.dashboard.handle(delivery(labeled, { id: "b", event: "star" }), OFF_BOX)).status).toBe(202);
    expect((await d.dashboard.handle(delivery({ zen: "z" }, { id: "c", event: "ping" }), OFF_BOX)).status).toBe(200);
    expect(d.state.latestDelivery()).toBe(0);
  });

  test("the secret opens only the webhook: other routes from off the box stay refused", async () => {
    const d = await dashboardWith(SECRET);
    restore = d.restore;
    expect((await d.dashboard.handle(new Request("http://factory.example:4100/api/runs"), OFF_BOX)).status).toBe(503);
  });
});

describe("startWatch wakes on a delivery", () => {
  test("a new delivery polls at once instead of waiting out the interval", async () => {
    const github = new Gh();
    const state = new FactoryState(":memory:");
    const config = mergeConfig({ repo: "acme/widgets", pollIntervalSeconds: 3600 });
    const stop = startWatch({ github, state } as never, config, undefined, 10);
    try {
      await Bun.sleep(50);
      expect(github.polls).toBe(1);
      state.recordDelivery({ id: "x", event: "issues", action: "labeled", repo: "acme/widgets" });
      await Bun.sleep(50);
      expect(github.polls).toBe(2);
      // Nothing new: no further poll.
      await Bun.sleep(50);
      expect(github.polls).toBe(2);
    } finally {
      stop();
    }
  });
});
