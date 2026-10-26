// One plane deployed on the web, steered from four places at once: an agent on this machine over
// MCP, a browser signed in as a member, a paired phone, and a runner on another machine that only
// dials out. Every command lands on the tracker or the runner that holds the work.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccess } from "../dashboard/plane/access";
import { PlaneStore } from "../dashboard/plane/store";
import { createDashboard } from "../dashboard/server";
import { newDeviceKey } from "../dashboard/public/lib/e2e.js";
import { SseEventSource } from "../src/adapters/sse/event-source";
import { runDir } from "../src/artifacts";
import { parseChatOps } from "../src/chatops";
import { LABEL } from "../src/labels";
import { createMcpServer } from "../src/mcp-server";
import { runnerWork } from "../src/remote-cli";
import { dialOut, registerRunner, type RunnerWork } from "../src/runner-channel";
import { FactoryState } from "../src/state";
import { AWAY, BASE, cookieOf, makePlane, owner, TrackerGitHub } from "./remote-plane";

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("control from anywhere", () => {
  test("a guarded web plane is driven from MCP, a browser, a phone and a remote runner", async () => {
    // Facing the web with nothing guarding it, the plane refuses every off-box caller.
    const open = createAccess({ token: "", store: new PlaneStore(), env: {} });
    const bare = createDashboard(
      new FactoryState(":memory:"),
      new TrackerGitHub(),
      "acme/widgets",
      false,
      "/nonexistent",
      undefined,
      undefined,
      undefined,
      open,
    );
    expect((await bare.handle(new Request(`${BASE}/api/runners`), AWAY)).status).toBe(503);

    const p = makePlane();
    p.github.labels[9] = LABEL.awaitingApproval;

    const mcp = createMcpServer({ github: p.github, repo: "acme/widgets", by: "the local owner" });
    const started = await mcp.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "start_task", arguments: { title: "Add dark mode" } },
    });
    expect(started).toMatchObject({ result: { isError: false } });
    expect(p.github.created[0]!.labels).toEqual([LABEL.ready]);

    const browser = p.member("approver", "bea");
    expect((await p.call("POST", "/api/issues/9/approve-plan", browser)).status).toBe(200);
    expect(parseChatOps(p.github.posted[0]!.body).type).toBe("approve");

    p.member("operator", "ana");
    const { link } = (await (await p.call("POST", "/api/pair", owner, { login: "ana" })).json()) as { link: string };
    const token = /#pair=([\w-]+)\./.exec(link)![1];
    const phone = cookieOf(
      await p.call("POST", "/api/pair/claim", "", { token, publicKey: (await newDeviceKey()).publicKey }),
    );

    // The runner's real CLI work, with the stage run itself held open so the test can steer it.
    const repoDir = mkdtempSync(join(tmpdir(), "factory-anywhere-"));
    const stopped: string[] = [];
    let finish = () => {};
    const work: RunnerWork = {
      ...runnerWork(new Map([["acme/widgets", repoDir]])),
      run: () => new Promise<void>((resolve) => (finish = resolve)),
      stop: async (j, kind) => void stopped.push(`${j.issue}:${kind}`),
    };
    const runnerToken = ((await (await p.call("POST", "/api/runners/token", owner)).json()) as { token: string }).token;
    const creds = await registerRunner(BASE, runnerToken, "far-box", p.net);
    const abort = new AbortController();
    const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret, p.net);
    const ch = dialOut(creds, work, {
      source,
      repos: ["acme/widgets"],
      fetch: p.net,
      signal: abort.signal,
      retryMs: 20,
    });
    await until(() => p.remote.hub.list()[0]?.online === true);

    expect((await p.call("POST", "/api/issues/41/dispatch", phone)).status).toBe(200);
    await until(() => p.remote.hub.holder({ repo: "acme/widgets", issue: 41 }) === creds.id);
    expect((await p.call("POST", "/api/issues/41/message", phone, { text: "keep the old palette" })).status).toBe(200);
    const notes = join(repoDir, runDir(41), "messages.md");
    await until(() => existsSync(notes) && readFileSync(notes, "utf8").includes("keep the old palette"));
    expect((await p.call("POST", "/api/issues/41/stop", browser)).status).toBe(403);
    expect((await p.call("POST", "/api/issues/41/stop", phone)).status).toBe(200);
    await until(() => stopped.includes("41:cancel"));
    expect(p.github.posted.at(-1)!.body).toContain("@ana");

    finish();
    abort.abort();
    await ch.done;
  });
});
