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
  const work: RunnerWork = { run: async (n) => void ran.push(n), deliver: async () => {}, stop: async () => {} };
  const abort = new AbortController();
  const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret, net);
  const ch = dialOut(creds, work, { source, fetch: net, signal: abort.signal, retryMs: 20, after });
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
    await until(() => p.remote.hub.holder(7) === null);
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
    hub.enqueue(7);
    const first = hub.holder(7)!;
    const other = first === a.id ? b.id : a.id;
    // Heartbeats every 15s keep a lease; the other runner keeps beating while the holder goes quiet.
    for (let t = HEARTBEAT_MS; t < LEASE_SILENCE_MS; t += HEARTBEAT_MS) {
      now += HEARTBEAT_MS;
      hub.heartbeat(other);
    }
    expect(hub.holder(7)).toBe(first);
    now += HEARTBEAT_MS + 1;
    hub.heartbeat(other);
    expect(hub.holder(7)).toBe(other);
    expect(hub.events(other, 0).map((e) => e.type)).toContain("lease");
  });
});
