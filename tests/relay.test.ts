// kaas-relay is a separate binary, so these drive it over real sockets: build, start, publish, read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayPublisher, relayTarget } from "../dashboard/relay";
import { followRelay, readRelay, relayStreamUrl, saveRelay } from "../dashboard/public/lib/relay-follow.js";

const ROOT = join(import.meta.dir, "..");
// One target per checkout, as in receipt.test.ts, so mutation copies never hand each other a binary.
const TARGET = join(
  process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "kaas-relay-target"),
  createHash("sha256").update(ROOT).digest("hex").slice(0, 12),
);
const BIN = join(TARGET, "release", "kaas-relay");
const PUBLISH = "pub-0123456789abcdef";
const SUBSCRIBE = "sub-0123456789abcdef";

let relay: ReturnType<typeof Bun.spawn>;
let base = "";

function start(env: Record<string, string>) {
  return Bun.spawn([BIN], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
}

beforeAll(async () => {
  const built = Bun.spawnSync(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--quiet",
      "--manifest-path",
      join(ROOT, "relay/Cargo.toml"),
      "--target-dir",
      TARGET,
    ],
    { stderr: "pipe" },
  );
  if (built.exitCode !== 0) throw new Error(`cargo build of relay/ failed: ${built.stderr.toString()}`);
  relay = start({
    KAAS_RELAY_PUBLISH_TOKEN: PUBLISH,
    KAAS_RELAY_SUBSCRIBE_TOKEN: SUBSCRIBE,
    KAAS_RELAY_ADDR: "127.0.0.1:0",
  });
  const reader = (relay.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  base = `http://${new TextDecoder().decode(value).match(/listening on (\S+)/)![1]}`;
}, 300_000);

afterAll(() => relay?.kill());

const publish = (channel: string, body: string, token = PUBLISH) =>
  fetch(`${base}/publish/${channel}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });

// Reads server-sent events until `count` data lines arrive, then closes the stream.
async function events(channel: string, count: number, query = `?token=${SUBSCRIBE}`) {
  const ac = new AbortController();
  const res = await fetch(`${base}/subscribe/${channel}${query}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const seen: string[] = [];
  let buf = "";
  const read = (async () => {
    while (seen.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const m of buf.matchAll(/^data: (.*)$/gm)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
    }
    ac.abort();
    return seen;
  })();
  return { res, read };
}

describe("kaas-relay", () => {
  test("refuses to start without two distinct tokens of 16 or more characters", () => {
    for (const env of [
      {},
      { KAAS_RELAY_PUBLISH_TOKEN: PUBLISH, KAAS_RELAY_SUBSCRIBE_TOKEN: "short" },
      { KAAS_RELAY_PUBLISH_TOKEN: PUBLISH, KAAS_RELAY_SUBSCRIBE_TOKEN: PUBLISH },
    ]) {
      const r = Bun.spawnSync([BIN], { env: { ...env, KAAS_RELAY_ADDR: "127.0.0.1:0" }, stderr: "pipe" });
      expect(r.exitCode).toBe(2);
    }
  });

  test("a late subscriber gets the last line at once, then each new one live", async () => {
    expect((await publish("inbox", '{"n":1}')).status).toBe(202);
    expect((await publish("inbox", '{"n":2}')).status).toBe(202);
    const sub = await events("inbox", 2);
    expect(sub.res.headers.get("content-type")).toBe("text/event-stream");
    expect(sub.res.headers.get("access-control-allow-origin")).toBe("*");
    await Bun.sleep(50);
    const live = await publish("inbox", '{"n":3}');
    expect(await live.text()).toBe('{"delivered":1}');
    expect(await sub.read).toEqual(['{"n":2}', '{"n":3}']);
  });

  test("channels are separate", async () => {
    await publish("a-1", '"a"');
    await publish("b-1", '"b"');
    const sub = await events("a-1", 1);
    expect(await sub.read).toEqual(['"a"']);
  });

  test("each token opens only its own side", async () => {
    expect((await publish("inbox", "{}", SUBSCRIBE)).status).toBe(401);
    expect((await publish("inbox", "{}", "")).status).toBe(401);
    expect((await fetch(`${base}/subscribe/inbox?token=${PUBLISH}`)).status).toBe(401);
    expect((await fetch(`${base}/subscribe/inbox`)).status).toBe(401);
    const header = await fetch(`${base}/subscribe/inbox`, { headers: { authorization: `Bearer ${SUBSCRIBE}` } });
    expect(header.status).toBe(200);
    await header.body?.cancel();
  });

  test("a body must be one line under 64 KiB, and a channel a short slug", async () => {
    expect((await publish("inbox", "a\nb")).status).toBe(400);
    expect((await publish("inbox", "")).status).toBe(400);
    expect((await publish("inbox", "x".repeat(64 * 1024 + 1))).status).toBe(413);
    expect((await publish("Inbox", "{}")).status).toBe(400);
    expect((await publish("x".repeat(65), "{}")).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
  });
});

describe("the dashboard publishes to it", () => {
  const inbox = {
    items: [
      {
        repo: "acme/w",
        issue: 7,
        title: "Fix",
        kind: "approve-plan",
        waitingSince: "2026-10-26T10:00:00Z",
        ask: "x".repeat(400),
        actions: ["approve"],
      },
    ],
  };
  const analytics = {
    week: { started: 1, shipped: 0, failed: 0 },
    spend7dUsd: 0.5,
    byModel: [{ key: "secret-model" }],
  };
  const handle = async (req: Request) => {
    const path = new URL(req.url).pathname;
    return Response.json(path === "/api/inbox" ? inbox : path === "/api/analytics" ? analytics : {}, {
      status: path === "/api/inbox" || path === "/api/analytics" ? 200 : 404,
    });
  };

  test("a relay needs both an address and a token", () => {
    expect(relayTarget({ FACTORY_RELAY_URL: "https://r.example/" })).toBeUndefined();
    expect(relayTarget({ FACTORY_RELAY_URL: "https://r.example/", FACTORY_RELAY_TOKEN: "t" })).toEqual({
      url: "https://r.example",
      token: "t",
      channel: "inbox",
    });
  });

  test("the inbox and the week reach a subscriber, trimmed, and an unchanged inbox is not sent twice", async () => {
    const tick = relayPublisher(handle, { url: base, token: PUBLISH, channel: "e2e" });
    expect(await tick()).toBe(true);
    expect(await tick()).toBe(false);
    const sub = await events("e2e", 1);
    const [line] = await sub.read;
    const got = JSON.parse(line!);
    expect(got.items[0]).toEqual({
      repo: "acme/w",
      issue: 7,
      title: "Fix",
      kind: "approve-plan",
      waitingSince: "2026-10-26T10:00:00Z",
      ask: "x".repeat(280),
    });
    expect(got.analytics).toEqual({ week: analytics.week, spend7dUsd: 0.5 });
  });

  test("a refused publish is retried on the next tick", async () => {
    const tick = relayPublisher(handle, { url: base, token: SUBSCRIBE, channel: "e2e-bad" });
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
  });
});

describe("the cockpit follows it", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
    };
  };

  test("settings round-trip, clear, and a throwing storage means no relay", () => {
    const s = memory();
    expect(readRelay(s)).toBeNull();
    expect(saveRelay(s, { url: "https://r.example/", token: "a b", channel: "inbox" })).toBe(true);
    expect(relayStreamUrl(readRelay(s)!)).toBe("https://r.example/subscribe/inbox?token=a%20b");
    saveRelay(s, null);
    expect(readRelay(s)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    expect(readRelay(broken)).toBeNull();
    expect(saveRelay(broken, { url: "u", token: "t" })).toBe(false);
  });

  test("only a line with an items list reaches the page", () => {
    let source: { onmessage?: (e: { data: string }) => void; url: string } | undefined;
    class Fake {
      onmessage?: (e: { data: string }) => void;
      constructor(public url: string) {
        source = this;
      }
      close() {}
    }
    const seen: unknown[] = [];
    followRelay(
      { url: "https://r.example", token: "t", channel: "inbox" },
      (p: unknown) => seen.push(p),
      Fake as unknown as typeof EventSource,
    );
    expect(source!.url).toBe("https://r.example/subscribe/inbox?token=t");
    source!.onmessage!({ data: "not json" });
    source!.onmessage!({ data: '{"nope":1}' });
    source!.onmessage!({ data: '{"items":[]}' });
    expect(seen).toEqual([{ items: [] }]);
  });
});

describe("wiring", () => {
  test("both ways of starting the dashboard start the publisher", () => {
    for (const file of ["src/cli.ts", "dashboard/server.ts"])
      expect(readFileSync(join(ROOT, file), "utf8")).toContain("startRelay(dashboard.handle);");
  });

  test("an unreachable dashboard falls back to the relay's inbox, read-only", () => {
    const app = readFileSync(join(ROOT, "dashboard/public/app.js"), "utf8");
    expect(app).toContain("state.inbox = state.relay.items;");
    expect(app).toContain("disabled: state.offline,");
    expect(app).toContain("startFollowing();\nloadInbox()");
  });
});
