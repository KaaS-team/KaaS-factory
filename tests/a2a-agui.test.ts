// A2A and AG-UI, two integrations a user turns on and the factory never runs by default: A2A answers
// only while FACTORY_A2A_TOKEN is set, and the AG-UI stream only while FACTORY_AGUI is set.
import { describe, expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";
import type { CloudEvent } from "../src/core/event";
import { A2A_ENV, taskState } from "../src/integrations/a2a";
import { SLACK_ENV } from "../src/integrations/slack";
import { AGUI_ENV, aguiEvents } from "../src/integrations/agui";
import { LinkStore } from "../src/integrations/links";
import type { BusEventRow } from "../src/state";
import { A2A_CARD_ROUTE, A2A_ROUTE, integrationRoutes, SLACK_ROUTE } from "../dashboard/plane/integrations";
import { MemoryTracker } from "./fixtures/tracker-server";

const REPO = "acme/shop";
const ev = (type: string, data: Record<string, unknown>): CloudEvent =>
  ({
    specversion: "1.0",
    id: `${type}/${String(data.step)}`,
    type,
    source: "f",
    time: "2026-10-26T10:00:00Z",
    data,
  }) as CloudEvent;
const base = { repo: REPO, issue: 6, workflow: "default" };
const run = [
  ev("factory.step.started", { ...base, step: "build" }),
  ev("factory.step.completed", { ...base, step: "build" }),
  ev("factory.step.started", { ...base, issue: 9, step: "plan" }),
  ev("factory.pr.opened", { ...base, url: "https://gh/pr/3", head: "x" }),
  ev("factory.run.completed", { ...base, outcome: "pr-opened" }),
];
const rows: BusEventRow[] = run.map((e) => ({
  id: e.id,
  direction: "out",
  type: e.type,
  source: e.source,
  subject: null,
  time: e.time,
  data: JSON.stringify(e.data),
  handled_at: null,
}));

function plane(env: Record<string, string>, repo = REPO) {
  const tracker = new MemoryTracker();
  const links = new LinkStore(":memory:");
  const { routes, bound } = integrationRoutes({
    state: { busEvents: () => rows },
    tracker,
    repo,
    env,
    links: () => links,
    store: { roleOf: () => null },
  });
  const call = (label: string, req: Request) => {
    const r = routes.find((x) => x.label === label)!;
    const url = new URL(req.url);
    return r.handler(req, url, url.pathname.match(r.pattern)!);
  };
  return { tracker, call, bound };
}
const rpc = (body: unknown, token = "a2a-tok") =>
  new Request("http://plane/a2a", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
const send = (text: string, taskId?: string) =>
  rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: { message: { taskId, parts: [{ kind: "text", text }] } },
  });

describe("A2A and AG-UI", () => {
  test("with neither key set, the agent card, the A2A endpoint and the AG-UI stream are 404", async () => {
    const p = plane({});
    expect((await p.call(A2A_CARD_ROUTE, new Request("http://plane/.well-known/agent-card.json"))).status).toBe(404);
    expect((await p.call(A2A_ROUTE, send("Fix the cart"))).status).toBe(404);
    expect((await p.call("GET /api/agui/:n", new Request("http://plane/api/agui/6"))).status).toBe(404);
  });

  test("on a plane with no default repo, a surface that is on refuses, and Settings is told which repo they use", async () => {
    const env = { [A2A_ENV.token]: "a2a-tok", [AGUI_ENV.on]: "1", [SLACK_ENV.secret]: "s" };
    const off = plane(env, "");
    expect((await off.call(A2A_ROUTE, send("Fix the cart"))).status).toBe(409);
    expect((await off.call("GET /api/agui/:n", new Request("http://plane/api/agui/6"))).status).toBe(409);
    const slack = new Request("http://plane/integrations/slack", { method: "POST", body: "{}" });
    expect((await off.call(SLACK_ROUTE, slack)).status).toBe(409);
    expect(off.bound()).toEqual({ repo: "", on: ["Slack", "A2A", "AG-UI"] });
    expect(plane(env).bound().repo).toBe(REPO);
  });

  test("an A2A client reads the card, starts a task, reads its state and approves its plan", async () => {
    const p = plane({ [A2A_ENV.token]: "a2a-tok" });
    const card = (await (
      await p.call(A2A_CARD_ROUTE, new Request("http://plane/.well-known/agent-card.json"))
    ).json()) as {
      url: string;
    };
    expect(card.url).toBe("http://plane/a2a");
    const started = (await (await p.call(A2A_ROUTE, send("Fix the cart\nIt drops items"))).json()) as {
      result: { id: string; status: { state: string } };
    };
    expect(started.result.status.state).toBe("submitted");
    const id = started.result.id;
    await p.tracker.addLabels(REPO, Number(id), ["factory:awaiting-approval"]);
    const got = (await (
      await p.call(A2A_ROUTE, rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id } }))
    ).json()) as {
      result: { status: { state: string } };
    };
    expect(got.result.status.state).toBe("input-required");
    await p.call(A2A_ROUTE, send("approve", id));
    const last = (await p.tracker.getIssue(REPO, Number(id))).comments.at(-1)!.body;
    expect(parseChatOps(last)).toEqual({ type: "approve" });
    expect((await p.call(A2A_ROUTE, rpc({ method: "tasks/get" }, "wrong"))).status).toBe(401);
    expect(taskState(["factory:failed"], false)).toBe("failed");
  });

  test("a message steers only its taskId's task, and one with no taskId cannot steer at all", async () => {
    const p = plane({ [A2A_ENV.token]: "a2a-tok" });
    const result = async (req: Request) => (await (await p.call(A2A_ROUTE, req)).json()) as { result?: { id: string } };
    const mine = (await result(send("Fix the cart"))).result!.id;
    const other = await p.tracker.createIssue(REPO, "Other", "", ["factory:awaiting-approval"]);
    await p.tracker.addLabels(REPO, Number(mine), ["factory:awaiting-approval"]);
    expect((await result(send(`approve #${other}`, mine))).result).toBeUndefined();
    expect((await result(send(`approve #${other}`))).result).toBeUndefined();
    for (const n of [other, Number(mine)])
      expect((await p.tracker.getIssue(REPO, n)).comments.some((c) => parseChatOps(c.body)?.type === "approve")).toBe(
        false,
      );
  });

  test("the AG-UI stream turns one issue's run into its run, step and finish events", async () => {
    expect(aguiEvents(run, REPO, 6).map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "STEP_STARTED",
      "STEP_FINISHED",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
    const p = plane({ [AGUI_ENV.on]: "1" });
    const res = await p.call("GET /api/agui/:n", new Request("http://plane/api/agui/6"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body.split("\n\n").filter(Boolean)).toHaveLength(5);
    expect(body).toContain('"stepName":"build"');
    expect(body).not.toContain('"stepName":"plan"');
  });
});
