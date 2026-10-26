// Steering a run in flight: a message waits on the plane, undoable, until the runner reads it;
// stop and takeover reach the runner that holds the issue, after a signed note on the tracker.
import { describe, expect, test } from "bun:test";
import { SseEventSource } from "../src/adapters/sse/event-source";
import { dialOut, registerRunner, type RunnerWork } from "../src/runner-channel";
import { BASE, makePlane, owner } from "./remote-plane";

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("mid-run commands", () => {
  test("a message is undoable until the runner reads it, and stop and takeover reach the runner", async () => {
    const p = makePlane();
    const operator = p.member("operator", "omar");
    const send = async (text: string) =>
      ((await (await p.call("POST", "/api/issues/7/message", operator, { text })).json()) as { id: number }).id;

    const undone = await send("use npm");
    expect((await p.call("POST", `/api/issues/7/messages/${undone}/undo`, operator)).status).toBe(200);
    const kept = await send("use pnpm, not npm");

    const { token } = (await (await p.call("POST", "/api/runners/token", owner)).json()) as { token: string };
    const creds = await registerRunner(BASE, token, "laptop", p.net);
    const got: string[] = [];
    let finish = () => {};
    const work: RunnerWork = {
      run: () => new Promise<void>((resolve) => (finish = resolve)),
      deliver: async (n, text) => void got.push(`${n}:${text}`),
      stop: async (n, kind) => void got.push(`${n}:${kind}`),
    };
    const abort = new AbortController();
    const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret, p.net);
    const ch = dialOut(creds, work, { source, fetch: p.net, signal: abort.signal, retryMs: 20 });
    await until(() => p.remote.hub.list()[0]?.online === true);
    await p.call("POST", "/api/issues/7/dispatch", operator);

    await until(() => got.includes("7:use pnpm, not npm"));
    expect(got).not.toContain("7:use npm");
    expect((await p.call("POST", `/api/issues/7/messages/${kept}/undo`, operator)).status).toBe(409);

    expect((await p.call("POST", "/api/issues/8/stop", operator)).status).toBe(409);
    expect((await p.call("POST", "/api/issues/7/takeover", operator)).status).toBe(200);
    expect((await p.call("POST", "/api/issues/7/stop", operator)).status).toBe(200);
    await until(() => got.includes("7:cancel"));
    expect(got).toEqual(["7:use pnpm, not npm", "7:takeover", "7:cancel"]);
    expect(p.github.posted.map((c) => c.issue)).toEqual([7, 7]);
    expect(p.github.posted[1]!.body).toContain("@omar");

    finish();
    abort.abort();
    await ch.done;
  });
});
