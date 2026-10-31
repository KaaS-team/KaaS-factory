import { describe, expect, test } from "bun:test";
import { tokenAuth } from "../src/api/auth";
import { coreRoutes, startFeedPoller } from "../src/api/core";
import { LIVE_EVENTS, type LiveEvent } from "../src/api/events";
import { fixture, FIXTURE_TOKEN } from "../src/api/fixtures";
import { ROUTES } from "../src/api/routes";
import { LiveFeed, RING_SIZE, sseResponse } from "../src/api/stream";
import { fitsSchema, type JsonSchema } from "../src/schemas";

// fitsSchema checks a node's type; this walks objects (required, extra keys) and arrays on top of it.
function problems(schema: JsonSchema, v: unknown, at = "$"): string[] {
  if (!fitsSchema(schema, v)) return [`${at}: does not fit ${JSON.stringify(schema)}`];
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (props && typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const out = ((schema.required as string[] | undefined) ?? [])
      .filter((k) => !(k in o))
      .map((k) => `${at}.${k}: missing`);
    for (const [k, val] of Object.entries(o)) {
      if (props[k]) out.push(...problems(props[k], val, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: unexpected`);
    }
    return out;
  }
  if (schema.type === "array")
    return (v as unknown[]).flatMap((x, i) => problems(schema.items as JsonSchema, x, `${at}[${i}]`));
  return [];
}

const auth = { authorization: `Bearer ${FIXTURE_TOKEN}` };
const get = (api: ReturnType<typeof coreRoutes>, path: string, headers: Record<string, string> = auth) =>
  api.fetch(new Request(`http://x${path}`, { headers }));

async function readFrames(res: Response, until: (text: string) => boolean): Promise<string> {
  const reader = res.body!.getReader();
  let text = "";
  while (!until(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return text;
}

describe("core routes", () => {
  test("every GET route answers a body that fits its res schema", async () => {
    const api = coreRoutes(fixture("two-repos"));
    const samples: Record<string, string> = {
      "runs.get": "/api/runs/acme%2Fweb/7",
      "runs.events": "/api/runs/acme%2Fweb/7/events",
    };
    for (const route of ROUTES.filter((r) => r.method === "GET" && !r.sse)) {
      const res = await get(api, samples[route.id] ?? route.path);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(problems(route.res, body)).toEqual([]);
    }
    const events = (await (await get(api, "/api/runs/acme%2Fweb/7/events")).json()) as { events: unknown[] };
    expect(events.events.length).toBe(2);
    expect(((await (await get(api, "/api/runs?repo=acme%2Fapi")).json()) as { runs: unknown[] }).runs.length).toBe(1);
  });

  test("fitsSchema rejects an array whose items do not fit, and a non-array", () => {
    const arr = { type: "array", items: { type: "string" } };
    expect(fitsSchema(arr, ["a"])).toBe(true);
    expect(fitsSchema(arr, [1])).toBe(false);
    expect(fitsSchema(arr, "a")).toBe(false);
  });

  test("a wrong bearer token gets 401, and so does none or an unset server token", async () => {
    const api = coreRoutes(fixture("two-repos"));
    const bad: Record<string, string>[] = [
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${FIXTURE_TOKEN}x` },
      { authorization: "Bearer " },
      { authorization: `Basic ${FIXTURE_TOKEN}` },
      {},
    ];
    for (const headers of bad) expect((await get(api, "/api/runs", headers)).status).toBe(401);
    expect((await get(api, "/api/runs")).status).toBe(200);
    expect((await get(api, "/api/health", {})).status).toBe(200);
    const unset = coreRoutes({ ...fixture("two-repos"), auth: tokenAuth({}) });
    expect((await get(unset, "/api/runs")).status).toBe(401);
    expect((await get(unset, "/api/events")).status).toBe(401);
  });

  test("unknown paths and methods are 404, a malformed issue is 400", async () => {
    const api = coreRoutes(fixture("two-repos"));
    expect((await get(api, "/api/nope")).status).toBe(404);
    expect((await api.fetch(new Request("http://x/api/runs", { method: "POST", headers: auth }))).status).toBe(404);
    for (const issue of ["abc", "0", "-1", "1.5"]) {
      expect((await get(api, `/api/runs/acme%2Fweb/${issue}`)).status).toBe(400);
    }
    expect((await get(api, "/api/runs/acme%2Fweb/999")).status).toBe(404);
    expect((await get(api, "/api/runs/acme%2Fnone/7")).status).toBe(404);
  });
});

describe("live events", () => {
  test("every pushed live event fits its LIVE_EVENTS schema", () => {
    const deps = fixture("two-repos");
    const states = new Map<string, ReturnType<typeof makeState>>();
    const pushed: LiveEvent[] = [];
    deps.feed.subscribe((e) => pushed.push(e));
    const poller = startFeedPoller(
      { repos: () => ["acme/x"], state: (r) => states.get(r) ?? null },
      deps.feed,
      3_600_000,
    );
    const st = makeState();
    states.set("acme/x", st);
    poller.tick();
    st.runs[0]!.stage = "verify";
    st.runs[0]!.updated_at = "2026-10-31T00:00:00.000Z";
    st.events.push({ id: 1, run_id: 1, ts: "t", stage: "verify", kind: "text", text: "hello" });
    poller.tick();
    st.runs[0]!.status = "shipped";
    poller.tick();
    poller.stop();
    expect(pushed.map((e) => e.type)).toEqual([
      "stage.started", // the run is new after the baseline pass
      "run.updated",
      "stage.finished", // build ended when the run moved to verify
      "stage.started",
      "run.updated",
      "log.appended",
      "stage.finished", // verify ended when the run shipped
      "run.updated",
    ]);
    for (const e of pushed) expect(problems(LIVE_EVENTS[e.type], e.data)).toEqual([]);
  });

  test("a stale Last-Event-ID gets a reset event", async () => {
    const feed = new LiveFeed();
    for (let i = 0; i < RING_SIZE + 5; i++) feed.push("repo.changed", { repo: "acme/web" });
    expect(feed.since(3).reset).toBe(true);
    expect(feed.since(RING_SIZE + 4).events?.length).toBe(1);
    const res = sseResponse(feed, 3, new AbortController().signal);
    const text = await readFrames(res, (t) => t.includes("event: reset"));
    expect(text).toContain("event: reset");
    expect(text).not.toContain("event: repo.changed");
  });

  test("a current Last-Event-ID replays only what it missed, with id and event lines", async () => {
    const feed = new LiveFeed();
    feed.push("repo.changed", { repo: "a/b" });
    feed.push("inbox.changed", { repo: "a/b" });
    const api = coreRoutes({ ...fixture("two-repos"), feed });
    const res = await get(api, "/api/events", { ...auth, "last-event-id": "1" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await readFrames(res, (t) => t.includes("inbox.changed"));
    expect(text).toContain('id: 2\nevent: inbox.changed\ndata: {"repo":"a/b"}');
    expect(text).not.toContain("id: 1\n");
    expect(feed.since(99).reset).toBe(true);
  });

  test("a live push reaches an open stream and a heartbeat comment is sent", async () => {
    const feed = new LiveFeed();
    const res = sseResponse(feed, undefined, new AbortController().signal, 10);
    setTimeout(() => feed.push("repo.changed", { repo: "a/b" }), 5);
    const text = await readFrames(res, (t) => t.includes("repo.changed") && t.includes(": heartbeat"));
    expect(text).toContain("event: repo.changed");
    expect(text).toContain(": heartbeat");
  });
});

function makeState() {
  const runs = [
    {
      id: 1,
      issue: 1,
      repo: "acme/x",
      title: "t",
      stage: "build",
      status: "running",
      started_at: "s",
      updated_at: "u0",
      tool_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      gate_line: null,
      pr_url: null,
      reason: null,
      status_comment_id: null,
      config_hash: null,
    },
  ] as never[] as Array<Record<string, unknown> & { stage: string; status: string; updated_at: string }>;
  const events: Array<{ id: number; run_id: number; ts: string; stage: string; kind: string; text: string }> = [];
  return {
    runs,
    events,
    listRuns: () => runs as never,
    getRun: () => runs[0] as never,
    listEvents: (_id: number, o?: { after?: number }) => events.filter((e) => e.id > (o?.after ?? 0)) as never,
    listStageRuns: () => [],
    spendSummary: () => ({ costUsd: 0, unreportedRuns: 0 }),
  };
}
