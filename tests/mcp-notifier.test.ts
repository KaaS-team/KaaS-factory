// The MCP integrations against a Streamable HTTP MCP server: the notifier (FACTORY_MCP_NOTIFY_URL,
// FACTORY_MCP_NOTIFY_TOOL, FACTORY_MCP_TOKEN), the event source (FACTORY_MCP_EVENTS_URL,
// FACTORY_MCP_EVENTS_TOOL) and a workflow's `uses: mcp` step.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudEvent } from "../src/core/event";
import { parseWorkflow } from "../src/core/workflow";
import { mcpStep } from "../src/engine/mcp-step";
import { STEP_TYPES } from "../src/engine/steps";
import { EXPR_ROOTS } from "../src/engine/workflows";
import { LinkStore } from "../src/integrations/links";
import { McpClient, MCP_ENV, recordMcpEvents } from "../src/integrations/mcp-client";
import { wireIntegrations } from "../src/integrations/wire";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGitHub } from "./harness";

type Call = { method: string; params: { name?: string; arguments?: Record<string, unknown> }; session: string | null };
const calls: Call[] = [];
let auth: string | null = null;
const event = (type: string) => ({
  specversion: "1.0",
  id: `e-${type}`,
  type,
  source: "shop",
  time: "2026-10-26T10:00:00Z",
});
const TOOLS: Record<string, unknown> = {
  notify: { content: [{ type: "text", text: "ok" }] },
  events: { structuredContent: { events: [event("tasks.task.ready"), event("factory.run.completed"), { junk: 1 }] } },
  close_ticket: { structuredContent: { closed: true } },
  broken: { isError: true, content: [{ type: "text", text: "ticket is locked" }] },
};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const m = (await req.json()) as Call & { id?: number };
    calls.push({ method: m.method, params: m.params, session: req.headers.get("mcp-session-id") });
    auth = req.headers.get("authorization");
    if (m.id === undefined) return new Response(null, { status: 202 });
    const result =
      m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : TOOLS[m.params.name!];
    // An SSE answer for tools/call, a JSON one for initialize: the client must read both.
    if (m.method === "tools/call")
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    return Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "mcp-session-id": "s-1" } });
  },
});
afterAll(() => server.stop());
const URL_ = `${server.url.origin}/mcp`;

describe("MCP notifier and event source", () => {
  test("each progress note is one tools/call on the notifier tool, in one session, with the token", async () => {
    calls.length = 0;
    const subs: ((e: CloudEvent) => Promise<void>)[] = [];
    const env = { [MCP_ENV.notifyUrl]: URL_, [MCP_ENV.notifyTool]: "notify", [MCP_ENV.token]: "tok" };
    expect(
      wireIntegrations({
        subscribe: (_t, fn) => subs.push(fn),
        links: new LinkStore(":memory:"),
        stageRuns: () => [],
        env,
      }),
    ).toEqual(["mcp-notifier"]);
    const data = { repo: "acme/shop", issue: 2, workflow: "default", step: "build" };
    for (const type of ["factory.step.started", "factory.step.completed"])
      for (const fn of subs)
        await fn({ specversion: "1.0", id: type, type, source: "f", time: "t", data } as CloudEvent);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(calls.slice(1).every((c) => c.session === "s-1")).toBe(true);
    expect(calls[2]!.params).toMatchObject({ name: "notify", arguments: { issue: 2, kind: "action", step: "build" } });
    expect(auth).toBe("Bearer tok");
  });

  test("the event source stores other apps' events once and drops factory types and junk", async () => {
    const state = new FactoryState(":memory:");
    const client = new McpClient(URL_);
    expect(await recordMcpEvents(client, "events", state)).toBe(1);
    expect(await recordMcpEvents(client, "events", state)).toBe(0);
    expect(state.unhandledInbound().map((e) => e.type)).toEqual(["tasks.task.ready"]);
  });
});

describe("uses: mcp step", () => {
  const clone = mkdtempSync(join(tmpdir(), "factory-mcp-"));
  mkdirSync(join(clone, ".factory"));
  writeFileSync(
    join(clone, ".factory", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        tickets: { type: "http", url: URL_, headers: { authorization: "Bearer ${FACTORY_MCP_TICKETS_TOKEN}" } },
        leaky: { type: "http", url: URL_, headers: { authorization: "Bearer ${GH_TOKEN}" } },
      },
    }),
  );
  const workflow = {
    name: "t",
    steps: {
      build: { uses: "build", label: "factory:building", next: "close" },
      close: { uses: "mcp", label: "factory:closing", run: "tickets/close_ticket", next: "pr" },
      pr: { uses: "pr", label: "factory:in-review" },
    },
  };

  test("a workflow may name a uses: mcp step, and the step calls the tool with the issue", async () => {
    const parsed = parseWorkflow(workflow, STEP_TYPES, EXPR_ROOTS);
    expect(parsed.ok ? [] : parsed.problems).toEqual([]);
    calls.length = 0;
    process.env.FACTORY_MCP_TICKETS_TOKEN = "tt";
    const step = { id: "close", label: "factory:closing", run: "tickets/close_ticket" };
    const r = await mcpStep.run({ deps: { cloneDir: clone }, issue: { number: 4, title: "Fix" }, step } as never);
    delete process.env.FACTORY_MCP_TICKETS_TOKEN;
    expect(r).toEqual({ kind: "next", facts: { closed: true } });
    expect(calls.at(-1)!.params).toEqual({ name: "close_ticket", arguments: { issue: 4, title: "Fix" } });
    expect(auth).toBe("Bearer tt");
  });

  test("a header naming ${GH_TOKEN} is refused: the step fails and no request leaves the runner", async () => {
    calls.length = 0;
    const had = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_secret";
    const github = new FakeGitHub([baseIssue(4, ["factory:closing"])]);
    const deps = { cloneDir: clone, github, state: new FactoryState(":memory:") };
    const step = { id: "close", label: "factory:closing", run: "leaky/close_ticket" };
    const r = await mcpStep.run({
      deps,
      config: { repo: "acme/shop" },
      issue: { number: 4, title: "Fix" },
      step,
    } as never);
    if (had === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = had;
    expect(r).toEqual({ kind: "stop", outcome: "failed" });
    expect(calls).toEqual([]);
  });

  test("a tool error fails the run with a comment and the failed label", async () => {
    const github = new FakeGitHub([baseIssue(4, ["factory:closing"])]);
    const deps = { cloneDir: clone, github, state: new FactoryState(":memory:") };
    const step = { id: "close", label: "factory:closing", run: "tickets/broken" };
    const r = await mcpStep.run({
      deps,
      config: { repo: "acme/shop" },
      issue: { number: 4, title: "Fix" },
      step,
    } as never);
    expect(r).toEqual({ kind: "stop", outcome: "failed" });
    const issue = await github.getIssue("acme/shop", 4);
    expect(issue.labels.map((l) => l.name)).toEqual(["factory:failed"]);
    expect(issue.comments.at(-1)!.body).toContain("the MCP tool `tickets/broken` returned an error");
  });
});
