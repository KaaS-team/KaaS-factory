import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdFor, cursorProvider } from "../src/cloud/cursor";
import { CloudError, type CloudStatus } from "../src/cloud/port";

const KEY = "cursor-secret-key-value";
const launchInput = {
  repoUrl: "https://github.com/o/r",
  branch: "feat/x",
  prompt: "do the thing",
  model: "claude-sonnet",
  key: "o/r#7#1",
  title: "issue 7",
};

type Recorded = { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> };

function recordingFetch(
  handler: (req: Recorded) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    const req = { method: init?.method ?? "GET", url, headers, body };
    calls.push(req);
    const out = handler(req);
    const h = new Headers(out.headers ?? {});
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status, headers: h });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function provider(fetchFn: typeof fetch, sleep: (ms: number) => Promise<void> = async () => {}) {
  return cursorProvider({
    secrets: { get: (n) => (n === "CURSOR_API_KEY" ? KEY : undefined) },
    keyEnv: "CURSOR_API_KEY",
    fetch: fetchFn,
    baseUrl: "https://cursor.test",
    sleep,
  });
}

function scanForKey(text: string, key: string): boolean {
  return text.includes(key);
}

describe("cursor cloud adapter", () => {
  test("agentIdFor is stable and keyed by attempt", () => {
    const a = agentIdFor("o/r#7#1");
    const b = agentIdFor("o/r#7#1");
    const c = agentIdFor("o/r#7#2");
    expect(a).toBe(b);
    expect(a.startsWith("bc-")).toBe(true);
    expect(c.startsWith("bc-")).toBe(true);
    expect(a).not.toBe(c);
  });

  test("idempotent launch", async () => {
    const { fetchFn, calls } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents"))
        return { status: 200, body: { id: req.body.agentId, status: "CREATING" } };
      return { status: 404, body: {} };
    });
    const p = provider(fetchFn);
    await p.launch(launchInput);
    await p.launch(launchInput);
    expect(calls[0]!.body.agentId).toBe(calls[1]!.body.agentId);
  });

  test("no auto PR by default", async () => {
    const { fetchFn, calls } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents"))
        return { status: 200, body: { id: req.body.agentId, status: "CREATING" } };
      return { status: 404, body: {} };
    });
    await provider(fetchFn).launch(launchInput);
    expect(calls[0]!.body.autoCreatePR).toBe(false);
    expect((calls[0]!.body.repos as { startingRef: string }[])[0]!.startingRef).toBe("feat/x");
  });

  test("key stays in the header", async () => {
    const messages: string[] = [];
    const { fetchFn, calls } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents")) return { status: 401, body: { error: "nope" } };
      return { status: 404, body: {} };
    });
    const p = provider(fetchFn);
    try {
      await p.launch(launchInput);
    } catch (e) {
      messages.push(String(e instanceof Error ? e.message : e));
    }
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    for (const c of calls) {
      expect(scanForKey(c.url, KEY)).toBe(false);
      expect(scanForKey(JSON.stringify(c.body), KEY)).toBe(false);
    }
    for (const m of messages) expect(scanForKey(m, KEY)).toBe(false);
  });

  test("rate limit", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { fetchFn } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents")) {
        n += 1;
        if (n === 1) return { status: 429, body: {}, headers: {} };
        return { status: 200, body: { id: req.body.agentId, status: "CREATING" } };
      }
      return { status: 404, body: {} };
    });
    await provider(fetchFn, async (ms) => {
      sleeps.push(ms);
    }).launch(launchInput);
    expect(sleeps).toEqual([2000]);
  });

  test("409 existing agent returns polled run", async () => {
    const running = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures/cloud/cursor-agent-running.json"), "utf8"),
    ) as Record<string, unknown>;
    const { fetchFn } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents"))
        return { status: 409, body: { error: "agent already existing" } };
      if (req.method === "GET" && req.url.includes("/v1/agents/")) return { status: 200, body: running };
      return { status: 404, body: {} };
    });
    const run = await provider(fetchFn).launch(launchInput);
    expect(run.status).toBe("running");
    expect(run.prUrl).toBe("https://github.com/o/r/pull/9");
  });

  test("status map", async () => {
    const cases: [string, CloudStatus][] = [
      ["CREATING", "creating"],
      ["RUNNING", "running"],
      ["WAITING_FOR_BACKGROUND_WORK", "running"],
      ["FINISHED", "finished"],
      ["ERROR", "error"],
      ["CANCELLED", "cancelled"],
      ["EXPIRED", "expired"],
    ];
    for (const [raw, expected] of cases) {
      const { fetchFn } = recordingFetch((req) => {
        if (req.method === "GET" && req.url.includes("/v1/agents/"))
          return { status: 200, body: { id: "bc-id", status: raw, git: { branches: [] } } };
        return { status: 404, body: {} };
      });
      const run = await provider(fetchFn).poll("bc-id");
      expect(run.status).toBe(expected);
    }
  });

  test("usage without numeric cost returns empty", async () => {
    const { fetchFn } = recordingFetch((req) => {
      if (req.method === "GET" && req.url.endsWith("/usage"))
        return { status: 200, body: { tokens: 1, _note: "no cost field" } };
      return { status: 404, body: {} };
    });
    const u = await provider(fetchFn).usage("bc-id");
    expect(u).toEqual({});
  });

  test("usage reads numeric cost", async () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures/cloud/cursor-usage.json"), "utf8"),
    ) as Record<string, unknown>;
    const { fetchFn } = recordingFetch((req) => {
      if (req.method === "GET" && req.url.endsWith("/usage")) return { status: 200, body: { ...fixture, cost: 1.25 } };
      return { status: 404, body: {} };
    });
    const u = await provider(fetchFn).usage("bc-id");
    expect(u.costUsd).toBe(1.25);
  });

  test("four 429s throw rate_limited", async () => {
    const { fetchFn } = recordingFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/agents")) return { status: 429, body: {} };
      return { status: 404, body: {} };
    });
    let err: CloudError | undefined;
    try {
      await provider(fetchFn, async () => {}).launch(launchInput);
    } catch (e) {
      err = e as CloudError;
    }
    if (!(err instanceof CloudError)) throw new Error("expected CloudError");
    expect(err.kind).toBe("rate_limited");
  });
});
