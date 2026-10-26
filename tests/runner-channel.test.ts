// The dial-out protocol end to end: a runner on another machine registers with a one-time token,
// follows its stream with nothing listening on its side, gets leases, and resumes where it stopped.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { HEARTBEAT_MS, LEASE_SILENCE_MS, RunnerHub } from "../dashboard/plane/runners";
import { SseEventSource } from "../src/adapters/sse/event-source";
import { dialOut, registerRunner, type RunnerCreds, type RunnerWork } from "../src/runner-channel";
import { BASE, makePlane, owner } from "./remote-plane";

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

function connect(net: typeof fetch, creds: RunnerCreds, after = 0) {
  const ran: number[] = [];
  const work: RunnerWork = { run: async (j) => void ran.push(j.issue), deliver: async () => {}, stop: async () => {} };
  const abort = new AbortController();
  const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret, net);
  const ch = dialOut(creds, work, {
    source,
    repos: ["acme/widgets"],
    fetch: net,
    signal: abort.signal,
    retryMs: 20,
    after,
  });
  return { ran, ch, stop: () => abort.abort() };
}

describe("runner dial-out", () => {
  test("a runner registers once, dials out, takes a lease, and resumes after a drop without replaying", async () => {
    const p = makePlane();
    const { token } = (await (await p.call("POST", "/api/runners/token", owner)).json()) as { token: string };
    const creds = await registerRunner(BASE, token, "build-box", p.net);
    await expect(registerRunner(BASE, token, "thief", p.net)).rejects.toThrow(/used or has expired/);

    const first = connect(p.net, creds);
    await until(() => p.remote.hub.list()[0]?.online === true);
    expect((await p.call("POST", "/api/issues/7/dispatch", owner)).status).toBe(200);
    await until(() => first.ran.includes(7));
    await until(() => p.remote.hub.holder({ repo: "acme/widgets", issue: 7 }) === null);
    first.stop();
    await first.ch.done;

    // Work queued while the runner was away arrives when it dials back in, and #7 is not run again.
    await p.call("POST", "/api/issues/8/dispatch", owner);
    const again = connect(p.net, creds, first.ch.lastSeq());
    await until(() => again.ran.includes(8));
    expect(again.ran).toEqual([8]);
    again.stop();
    await again.ch.done;
  });

  test("a lease whose runner is silent for 60s goes back to the queue and to a runner still heard from", () => {
    let now = 1_000_000;
    const hub = new RunnerHub(new Database(":memory:"), () => now);
    const a = hub.register(hub.issueToken(), "a")!;
    const b = hub.register(hub.issueToken(), "b")!;
    for (const r of [a, b]) hub.heartbeat(r.id, ["acme/widgets"]);
    hub.enqueue({ repo: "acme/widgets", issue: 7 });
    const first = hub.holder({ repo: "acme/widgets", issue: 7 })!;
    const other = first === a.id ? b.id : a.id;
    // Heartbeats every 15s keep a lease; the other runner keeps beating while the holder goes quiet.
    for (let t = HEARTBEAT_MS; t < LEASE_SILENCE_MS; t += HEARTBEAT_MS) {
      now += HEARTBEAT_MS;
      hub.heartbeat(other);
    }
    expect(hub.holder({ repo: "acme/widgets", issue: 7 })).toBe(first);
    now += HEARTBEAT_MS + 1;
    hub.heartbeat(other);
    expect(hub.holder({ repo: "acme/widgets", issue: 7 })).toBe(other);
    expect(hub.events(other, 0).map((e) => e.type)).toContain("lease");
  });

  test("the same issue number in two repos is two jobs, and a runner gets work only in repos it holds", () => {
    const hub = new RunnerHub(new Database(":memory:"));
    const a = hub.register(hub.issueToken(), "a-box")!;
    const b = hub.register(hub.issueToken(), "b-box")!;
    hub.heartbeat(a.id, ["acme/a"]);
    hub.heartbeat(b.id, ["acme/b"]);
    hub.enqueue({ repo: "acme/a", issue: 7 });
    hub.enqueue({ repo: "acme/b", issue: 7 });
    hub.enqueue({ repo: "acme/c", issue: 7 });
    expect(hub.holder({ repo: "acme/a", issue: 7 })).toBe(a.id);
    expect(hub.holder({ repo: "acme/b", issue: 7 })).toBe(b.id);
    // No runner holds a checkout of acme/c, so its job waits instead of running in the wrong one.
    expect(hub.holder({ repo: "acme/c", issue: 7 })).toBeNull();
    hub.signal({ repo: "acme/b", issue: 7 }, "cancel", "ana");
    expect(hub.events(a.id, 0).map((e) => e.type)).toEqual(["lease"]);
    expect(hub.events(b.id, 0).map((e) => [e.type, JSON.parse(e.data).repo])).toEqual([
      ["lease", "acme/b"],
      ["cancel", "acme/b"],
    ]);
    expect(hub.done(a.id, { repo: "acme/b", issue: 7 })).toBe(false);
  });

  test("a hub from before multi-repo drops its issue-keyed jobs and opens", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE plane_jobs (issue INTEGER PRIMARY KEY, state TEXT NOT NULL, runner TEXT, leased_at INTEGER)");
    db.exec("INSERT INTO plane_jobs VALUES (7, 'queued', NULL, NULL)");
    const hub = new RunnerHub(db);
    hub.enqueue({ repo: "acme/a", issue: 7 });
    expect(db.query("SELECT repo, issue FROM plane_jobs").all()).toEqual([{ repo: "acme/a", issue: 7 }]);
  });

  test("a runner ignores work for a repo it holds no checkout of, even if the plane sends it", async () => {
    const ran: string[] = [];
    const abort = new AbortController();
    const events = [
      { seq: 1, type: "lease", data: { repo: "acme/other", issue: 7 } },
      { seq: 2, type: "lease", data: { repo: "acme/widgets", issue: 8 } },
    ];
    const source = {
      follow: async (_after: number, on: (e: (typeof events)[number]) => Promise<void> | void) => {
        for (const e of events) await on(e);
        abort.abort();
        return 2;
      },
    };
    const work: RunnerWork = {
      run: async (j) => void ran.push(`${j.repo}#${j.issue}`),
      deliver: async () => {},
      stop: async () => {},
    };
    const net = (async () => new Response("{}")) as unknown as typeof fetch;
    const creds = { url: BASE, id: "r", secret: "s" };
    const ch = dialOut(creds, work, { source, repos: ["acme/widgets"], fetch: net, signal: abort.signal, retryMs: 1 });
    await ch.done;
    expect(ran).toEqual(["acme/widgets#8"]);
  });
});
