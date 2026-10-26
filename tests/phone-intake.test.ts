// The whole loop from a phone: file a task from the PWA, see it on the board, a dialled-out runner
// builds it, the phone is told it shipped, a human merges from the phone, and the read-only relay
// view the phone follows shows the shipped run, sealed so only the phone can read it.
import { describe, expect, test } from "bun:test";
import { relayPublisher } from "../dashboard/relay";
import { newDeviceKey, openBox } from "../dashboard/public/lib/e2e.js";
import { SseEventSource } from "../src/adapters/sse/event-source";
import { LABEL } from "../src/labels";
import type { GhIssue, GhPr, MergeReadiness, PrStatus } from "../src/github";
import { dialOut, registerRunner, type RunnerWork } from "../src/runner-channel";
import { BASE, cookieOf, makePlane, owner, TrackerGitHub } from "./remote-plane";

class Repo extends TrackerGitHub {
  merged: number[] = [];
  override async listOpenIssues(): Promise<GhIssue[]> {
    return this.created.map((c, i) => ({
      number: 41 + i,
      title: c.title,
      body: c.body,
      labels: c.labels.map((name) => ({ name })),
      comments: [],
    }));
  }
  override async prForIssue(_repo: string, issue: number): Promise<GhPr | undefined> {
    return {
      number: 100 + issue,
      url: "",
      state: "open",
      headRefName: `issue-${issue}`,
      isDraft: false,
      closingIssuesReferences: [{ number: issue }],
    };
  }
  override async prStatus(): Promise<PrStatus> {
    return {
      state: "open",
      headRefOid: "sha1",
      closingIssuesReferences: [],
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
  }
  override async mergeReadiness(): Promise<MergeReadiness> {
    return {
      state: "open",
      isDraft: false,
      baseRefName: "main",
      headRefOid: "sha1",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      hasUnresolvedReviewThreads: false,
      changesRequestedStale: false,
    };
  }
  override async mergePr(_repo: string, pr: number): Promise<void> {
    this.merged.push(pr);
  }
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("phone intake", () => {
  test("a phone files a task, a remote runner ships it, and the phone merges and sees it shipped", async () => {
    const p = makePlane(new Repo());
    const github = p.github as Repo;
    p.member("operator", "ana");
    const { link } = (await (await p.call("POST", "/api/pair", owner, { login: "ana" })).json()) as { link: string };
    const [, token, sender] = /#pair=([\w-]+)\.([\w-]+)$/.exec(link)!;
    const key = await newDeviceKey();
    const claimed = await p.call("POST", "/api/pair/claim", "", { token, publicKey: key.publicKey });
    const phone = cookieOf(claimed);
    const { device } = (await claimed.json()) as { device: string };
    await p.remote.push.tick();

    const filed = await p.call("POST", "/api/tasks", phone, { title: "Export invoices as CSV" });
    const { issue } = (await filed.json()) as { issue: number };
    expect(github.created[0]).toMatchObject({ labels: [LABEL.ready], body: expect.stringContaining("@ana") });
    const board = (await (await p.call("GET", "/api/board", phone)).json()) as {
      cards: { issue: number; title: string }[];
    };
    expect(board.cards).toContainEqual(expect.objectContaining({ issue, title: "Export invoices as CSV" }));

    const runnerToken = ((await (await p.call("POST", "/api/runners/token", owner)).json()) as { token: string }).token;
    const creds = await registerRunner(BASE, runnerToken, "build-box", p.net);
    const work: RunnerWork = {
      run: async (n) =>
        void p.state.upsertRun({
          issue: n,
          repo: "acme/widgets",
          title: "Export invoices as CSV",
          stage: "pr",
          status: "shipped",
        }),
      deliver: async () => {},
      stop: async () => {},
    };
    const abort = new AbortController();
    const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret, p.net);
    const link2 = dialOut(creds, work, { source, fetch: p.net, signal: abort.signal, retryMs: 20 });
    await until(() => p.remote.hub.list()[0]?.online === true);
    expect((await p.call("POST", `/api/issues/${issue}/dispatch`, phone)).status).toBe(200);
    await until(() => p.state.getRun("acme/widgets", issue)?.status === "shipped");
    abort.abort();
    await link2.done;

    const told = await p.remote.push.tick();
    expect(told).toContainEqual(expect.objectContaining({ kind: "done", title: expect.stringContaining(`#${issue}`) }));

    const merge = await p.call("POST", `/api/issues/${issue}/merge`, phone);
    expect(merge.status).toBe(200);
    expect(github.merged).toEqual([100 + issue]);

    const sent: string[] = [];
    const send = (async (_u: unknown, init?: RequestInit) => (
      sent.push(String(init?.body)), new Response("{}")
    )) as typeof fetch;
    const target = { url: "https://relay.example", token: "relay-token", channel: "inbox" };
    expect(await relayPublisher(p.dashboard.readInProcess, target, send, p.remote.sealer)()).toBe(true);
    expect(sent[0]).not.toContain("invoices");
    const view = JSON.parse(await openBox(JSON.parse(sent[0]!).sealed, device, key.privateKey, sender!));
    expect(view.analytics.week).toMatchObject({ started: 1, shipped: 1 });
  });
});
