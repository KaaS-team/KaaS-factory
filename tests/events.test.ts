// The v4 event bus: the CloudEvents envelope and catalogue, the HMAC, the
// SQLite outbox with its retries, and the structural check that every type the
// code emits is in the catalogue.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVENT_TYPES, FACTORY_EVENTS, EVENT_SIGNATURE_HEADER, parseEvent, signEvent, verifyEvent } from "../src/core/event";
import { EventBus, backoffMs } from "../src/engine/bus";
import { FactoryState } from "../src/state";
import { configProblems, DEFAULT_EVENTS_SECRET_ENV } from "../src/config";
import { createDashboard } from "../dashboard/server";
import { FakeGitHub } from "./harness";
import { createHmac } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const SECRET_ENV = "TEST_SINK_SECRET";
const SECRET = "sink-secret-value";

function srcFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => join(d.parentPath, d.name));
}

describe("event catalogue", () => {
  test("every type the code emits is in EVENT_TYPES, and every factory type is emitted somewhere", () => {
    const known = new Set<string>(EVENT_TYPES);
    const emitted = new Set<string>();
    // emitEvent(bus, "type", ...) and bus.emit("type", ...) are the only two emit forms.
    const re = /(?:emitEvent\([^,]+,\s*|\.emit\()\s*["']([\w.]+)["']/g;
    for (const f of [...srcFiles("src"), ...srcFiles("dashboard")]) {
      for (const m of readFileSync(f, "utf8").matchAll(re)) emitted.add(m[1]!);
    }
    expect([...emitted].filter((t) => !known.has(t))).toEqual([]);
    expect(FACTORY_EVENTS.filter((t) => !emitted.has(t))).toEqual([]);
  });

  test("the scanner sees both emit forms", () => {
    const re = /(?:emitEvent\([^,]+,\s*|\.emit\()\s*["']([\w.]+)["']/g;
    const text = 'emitEvent(deps.bus, "factory.a.b", {});\nthis.bus.emit("factory.c.d", x);';
    expect([...text.matchAll(re)].map((m) => m[1])).toEqual(["factory.a.b", "factory.c.d"]);
  });

  test("types are unique and namespaced app.noun.verb", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    for (const t of EVENT_TYPES) expect(t).toMatch(/^[a-z]+\.[a-z]+\.[a-z]+$/);
  });

  test("parseEvent checks the envelope", () => {
    const good = { specversion: "1.0", id: "e1", source: "tasks", type: "tasks.task.ready", time: "2026-10-11T00:00:00Z", data: { n: 1 } };
    expect(parseEvent(good)).toEqual({ ok: true, event: good as never });
    expect(parseEvent({ ...good, specversion: "0.3" }).ok).toBe(false);
    expect(parseEvent({ ...good, id: "" }).ok).toBe(false);
    expect(parseEvent({ ...good, time: "yesterday" }).ok).toBe(false);
    expect(parseEvent([good]).ok).toBe(false);
  });
});

describe("signature", () => {
  test("matches HMAC-SHA256 as node computes it", () => {
    const body = '{"a":1}';
    expect(signEvent("k", body)).toBe(`sha256=${createHmac("sha256", "k").update(body).digest("hex")}`);
  });

  test("verify accepts the right signature and refuses a wrong body, secret, header or empty secret", () => {
    const body = '{"a":1}';
    const sig = signEvent("k", body);
    expect(verifyEvent("k", body, sig)).toBe(true);
    expect(verifyEvent("k", '{"a":2}', sig)).toBe(false);
    expect(verifyEvent("j", body, sig)).toBe(false);
    expect(verifyEvent("k", body, null)).toBe(false);
    expect(verifyEvent("k", body, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(verifyEvent("", body, signEvent("", body))).toBe(false);
  });
});

describe("events config", () => {
  test("a sink needs a URL and an env var name, and types from the catalogue", () => {
    expect(configProblems({ events: { sinks: [{ url: "https://x.test/e", secretEnv: "KAAS_SECRET", types: ["factory.pr.merged"] }], inboundSecretEnv: "IN_SECRET" } })).toEqual([]);
    const bad = configProblems({ events: { sinks: [{ url: "ftp://x", secretEnv: "a literal secret", types: ["nope.x.y"] }], extra: 1 } });
    expect(bad.some((p) => p.includes("events.extra: unknown key"))).toBe(true);
    expect(bad.some((p) => p.includes("events.sinks[0].url"))).toBe(true);
    expect(bad.some((p) => p.includes("events.sinks[0].secretEnv"))).toBe(true);
    expect(bad.some((p) => p.includes('"nope.x.y" is not an event type'))).toBe(true);
  });
});

function clock(start = Date.parse("2026-10-11T00:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

describe("bus", () => {
  test("a sink that fails twice then succeeds gets the event exactly once, signed", async () => {
    const state = new FactoryState(":memory:");
    const c = clock();
    const received: { body: string; sig: string | null }[] = [];
    let calls = 0;
    const bus = new EventBus({
      store: state,
      sinks: [{ url: "https://sink.test/e", secretEnv: SECRET_ENV }],
      source: "factory/o/r",
      env: { [SECRET_ENV]: SECRET },
      now: c.now,
      autoDeliver: false,
      log: () => {},
      fetch: async (_url, init) => {
        calls++;
        if (calls <= 2) return new Response("down", { status: 503 });
        received.push({ body: String(init.body), sig: new Headers(init.headers).get(EVENT_SIGNATURE_HEADER) });
        return new Response(null, { status: 202 });
      },
    });
    const ev = bus.emit("factory.pr.merged", { pr: 7 }, "issue/3");
    expect(await bus.deliver()).toBe(0);
    // Not due again until the backoff passes.
    expect(await bus.deliver()).toBe(0);
    expect(calls).toBe(1);
    c.advance(backoffMs(1));
    expect(await bus.deliver()).toBe(0);
    c.advance(backoffMs(2));
    expect(await bus.deliver()).toBe(1);
    c.advance(backoffMs(8));
    expect(await bus.deliver()).toBe(0);
    expect(calls).toBe(3);
    expect(received.length).toBe(1);
    expect(verifyEvent(SECRET, received[0]!.body, received[0]!.sig)).toBe(true);
    expect(JSON.parse(received[0]!.body)).toEqual({ ...ev, data: { pr: 7 } });
    expect(state.busDeliveries(ev.id).map((d) => [d.status, d.attempts])).toEqual([["delivered", 3]]);
  });

  test("a sink's types filter what it gets; a missing secret is a failed attempt that never sends", async () => {
    const state = new FactoryState(":memory:");
    let calls = 0;
    const logs: string[] = [];
    const bus = new EventBus({
      store: state,
      sinks: [{ url: "https://a.test", secretEnv: "UNSET_VAR", types: ["factory.pr.opened"] }],
      source: "factory/o/r",
      env: {},
      autoDeliver: false,
      log: (l) => logs.push(l),
      fetch: async () => {
        calls++;
        return new Response(null, { status: 200 });
      },
    });
    const skipped = bus.emit("factory.step.started", {});
    const kept = bus.emit("factory.pr.opened", {});
    await bus.deliver();
    expect(state.busDeliveries(skipped.id)).toEqual([]);
    expect(state.busDeliveries(kept.id)[0]!.last_error).toBe("UNSET_VAR is unset");
    expect(calls).toBe(0);
  });

  test("delivery gives up after maxAttempts and replay re-queues it", async () => {
    const state = new FactoryState(":memory:");
    const c = clock();
    let ok = false;
    const bus = new EventBus({
      store: state,
      sinks: [{ url: "https://a.test", secretEnv: SECRET_ENV }],
      source: "s",
      env: { [SECRET_ENV]: SECRET },
      now: c.now,
      maxAttempts: 2,
      autoDeliver: false,
      log: () => {},
      fetch: async () => new Response(null, { status: ok ? 200 : 500 }),
    });
    const ev = bus.emit("factory.run.completed", {});
    await bus.deliver();
    c.advance(backoffMs(1));
    await bus.deliver();
    expect(state.busDeliveries(ev.id)[0]!.status).toBe("dead");
    ok = true;
    expect(bus.replay(ev.id)).toBe(1);
    expect(await bus.deliver()).toBe(1);
  });

  test("subscribers hear emitted and drained inbound events; a throwing one is contained", () => {
    const state = new FactoryState(":memory:");
    const bus = new EventBus({ store: state, sinks: [], source: "s", autoDeliver: false, log: () => {} });
    const heard: string[] = [];
    bus.subscribe("*", () => {
      throw new Error("boom");
    });
    bus.subscribe("*", (e) => void heard.push(e.type));
    bus.subscribe("wiki.page.updated", (e) => void heard.push(`only:${e.id}`));
    bus.emit("factory.issue.ready", { issue: 1 });
    expect(state.recordBusEvent({ id: "in-1", direction: "in", type: "wiki.page.updated", source: "wiki", subject: null, time: new Date().toISOString(), data: "{}", handled_at: null })).toBe(true);
    expect(bus.drainInbound()).toBe(1);
    expect(bus.drainInbound()).toBe(0);
    expect(heard).toEqual(["factory.issue.ready", "only:in-1", "wiki.page.updated"]);
  });
});

describe("POST /events", () => {
  const IN_SECRET = "inbound-secret-for-tests";
  const OFF_BOX = "203.0.113.7";
  let restore = () => {};
  afterEach(() => restore());

  function dashboardWith(secret: string | undefined) {
    const before = process.env[DEFAULT_EVENTS_SECRET_ENV];
    if (secret === undefined) delete process.env[DEFAULT_EVENTS_SECRET_ENV];
    else process.env[DEFAULT_EVENTS_SECRET_ENV] = secret;
    restore = () => (before === undefined ? delete process.env[DEFAULT_EVENTS_SECRET_ENV] : (process.env[DEFAULT_EVENTS_SECRET_ENV] = before));
    const state = new FactoryState(":memory:");
    return { state, dashboard: createDashboard(state, new FakeGitHub([]), "acme/widgets", false, "/nonexistent") };
  }

  const event = (over: Record<string, unknown> = {}) => ({ specversion: "1.0", id: "wiki-1", source: "wiki", type: "wiki.page.updated", time: "2026-10-11T00:00:00Z", data: { page: "setup" }, ...over });
  function post(body: object, opts: { secret?: string; sig?: string; type?: string } = {}) {
    const raw = JSON.stringify(body);
    return new Request("http://factory.example:4100/events", {
      method: "POST",
      headers: { "content-type": opts.type ?? "application/cloudevents+json", [EVENT_SIGNATURE_HEADER]: opts.sig ?? signEvent(opts.secret ?? IN_SECRET, raw) },
      body: raw,
    });
  }

  test("is off (404) until the inbound secret is set", async () => {
    const d = dashboardWith(undefined);
    expect((await d.dashboard.handle(post(event()), "127.0.0.1")).status).toBe(404);
  });

  test("a bad or missing signature is 401 and records nothing", async () => {
    const d = dashboardWith(IN_SECRET);
    expect((await d.dashboard.handle(post(event(), { secret: "guess" }), OFF_BOX)).status).toBe(401);
    expect((await d.dashboard.handle(post(event(), { sig: "" }), OFF_BOX)).status).toBe(401);
    expect(d.state.busEvents()).toEqual([]);
  });

  test("a signed event from off the box is stored once; a duplicate id is acknowledged, not stored again", async () => {
    const d = dashboardWith(IN_SECRET);
    expect((await d.dashboard.handle(post(event()), OFF_BOX)).status).toBe(201);
    expect((await d.dashboard.handle(post(event({ data: { page: "other" } })), OFF_BOX)).status).toBe(200);
    expect((await d.dashboard.handle(post(event(), { type: "application/json" }), OFF_BOX)).status).toBe(200);
    const rows = d.state.busEvents();
    expect(rows.map((r) => [r.id, r.direction, r.type, r.handled_at, JSON.parse(r.data)])).toEqual([["wiki-1", "in", "wiki.page.updated", null, { page: "setup" }]]);
  });

  test("a factory type or an unknown type is ignored (202); a bad envelope is 400", async () => {
    const d = dashboardWith(IN_SECRET);
    expect((await d.dashboard.handle(post(event({ id: "f", type: "factory.pr.merged" })), OFF_BOX)).status).toBe(202);
    expect((await d.dashboard.handle(post(event({ id: "u", type: "wiki.page.deleted" })), OFF_BOX)).status).toBe(202);
    expect((await d.dashboard.handle(post(event({ specversion: "0.3" })), OFF_BOX)).status).toBe(400);
    expect(d.state.busEvents()).toEqual([]);
  });
});
