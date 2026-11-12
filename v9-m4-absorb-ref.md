# factory-mcp reference sources (KaaS-team/factory-mcp@3afa05a7f5dc, Apache-2.0, read only)

## src/tools.ts
```
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { FactoryClient } from "./client.js";

export interface ToolDef {
  name: string;
  /** Protocol route id this tool maps to. */
  route: string;
  description: string;
  annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;
  input: z.ZodRawShape;
  call(client: FactoryClient, args: Record<string, unknown>): Promise<unknown>;
}

const idShape = { id: z.string().min(1).describe("Task id") };
const messageShape = { ...idShape, message: z.string().min(1).describe("Message text") };

type Ann = ToolDef["annotations"];
const READ: Ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: "list_tasks",
    route: "runs.list",
    description: "List all tasks the factory knows about. Read-only.",
    annotations: READ,
    input: {},
    call: (c) => c.listTasks(),
  },
  {
    name: "get_task",
    route: "runs.get",
    description: "Read one task by id. Read-only.",
    annotations: READ,
    input: idShape,
    call: (c, a) => c.getTask(a.id as string),
  },
  {
    name: "create_task",
    route: "tasks.create",
    description:
      "Create a new task. Each call creates another task, so repeating it makes duplicates. Never removes or changes existing tasks.",
    annotations: WRITE,
    input: {
      title: z.string().min(1).describe("Short task title"),
      body: z.string().optional().describe("Longer description"),
    },
    call: (c, a) => c.createTask({ title: a.title as string, body: a.body as string | undefined }),
  },
  {
    name: "hand_off_task",
    route: "tasks.hand_off",
    description:
      "Hand a task to another assignee. This replaces the current assignee, so the previous owner loses it. Repeating the same hand-off leaves the same end state.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: {
      ...idShape,
      to: z.string().min(1).describe("New assignee"),
      note: z.string().optional().describe("Context for the new assignee"),
    },
    call: (c, a) =>
      c.handOffTask({ id: a.id as string, to: a.to as string, note: a.note as string | undefined }),
  },
  {
    name: "approve_plan",
    route: "runs.approve",
    description:
      "Approve the pending plan of a run so it can continue. Changes the run state; the factory decides what happens on a repeat call.",
    annotations: WRITE,
    input: idShape,
    call: (c, a) => c.approvePlan(a.id as string),
  },
  {
    name: "steer",
    route: "runs.steer",
    description:
      "Send a steering message to a run. Each call sends another message. Does not remove or edit earlier ones.",
    annotations: WRITE,
    input: messageShape,
    call: (c, a) => c.steer({ id: a.id as string, message: a.message as string }),
  },
  {
    name: "queue_followup",
    route: "runs.queue",
    description:
      "Queue a follow-up message for a run. Each call queues another message. Does not remove or edit earlier ones.",
    annotations: WRITE,
    input: messageShape,
    call: (c, a) => c.queueFollowup({ id: a.id as string, message: a.message as string }),
  },
  {
    name: "retry",
    route: "runs.retry",
    description: "Ask the factory to retry a run. Each call is a new request; the factory decides what a retry does.",
    annotations: WRITE,
    input: idShape,
    call: (c, a) => c.retry(a.id as string),
  },
  {
    name: "list_events",
    route: "runs.events",
    description: "List the events of one run, as the factory returns them. Read-only.",
    annotations: READ,
    input: idShape,
    call: (c, a) => c.listEvents(a.id as string),
  },
  {
    name: "spend",
    route: "spend.get",
    description: "Read the spend report, exactly as the factory returns it for this token. Read-only.",
    annotations: READ,
    input: {},
    call: (c) => c.spend(),
  },
  {
    name: "list_repos",
    route: "repos.list",
    description: "List the repositories the factory knows about. Read-only.",
    annotations: READ,
    input: {},
    call: (c) => c.listRepos(),
  },
  {
    name: "get_metrics",
    route: "metrics.get",
    description: "Read the factory metrics, exactly as the factory returns them. Read-only. A value the factory does not report is absent, never zero.",
    annotations: READ,
    input: {},
    call: (c) => c.getMetrics(),
  },
];
```

## src/http.ts
```
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export interface HttpOptions {
  port: number;
  token: string;
  /** Interface to bind. Defaults to loopback. */
  host?: string;
}

export interface HttpHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * Serve `server` on the SDK streamable HTTP transport at /mcp.
 * One transport serves one MCP session: `server` talks to one client at a time.
 */
export async function startHttp(server: McpServer, { port, token, host = "127.0.0.1" }: HttpOptions): Promise<HttpHandle> {
  if (!token) throw new Error("startHttp: token must not be empty");
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);

  async function handle(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
    if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
    return transport.handleRequest(req);
  }

  const http: Server = createServer((incoming, outgoing) => {
    void respond(incoming, outgoing, handle, host);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  const bound = (http.address() as AddressInfo).port;
  return {
    url: `http://${host}:${bound}/mcp`,
    async close() {
      await transport.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handle: (req: Request) => Promise<Response>,
  host: string,
): Promise<void> {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(incoming.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const method = incoming.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const chunks: Buffer[] = [];
    if (hasBody) for await (const c of incoming) chunks.push(c as Buffer);
    const request = new Request(`http://${incoming.headers.host ?? host}${incoming.url ?? "/"}`, {
      method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const res = await handle(request);
    outgoing.writeHead(res.status, Object.fromEntries(res.headers));
    if (!res.body) return void outgoing.end();
    const reader = res.body.getReader();
    outgoing.on("close", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
    outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}
```

## src/client.ts
```
/** Small interface to the factory. Injected into the server; faked in tests. */
export interface Task {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
}

export interface HandOffInput {
  id: string;
  to: string;
  note?: string;
}

/** Message aimed at a run (steer or queue). */
export interface RunMessageInput {
  id: string;
  message: string;
}

/**
 * Bodies of the read routes below are passed through as the route returned
 * them; the client does not reshape them.
 */
export interface FactoryClient {
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  handOffTask(input: HandOffInput): Promise<Task>;
  /** runs.approve */
  approvePlan(id: string): Promise<unknown>;
  /** runs.steer */
  steer(input: RunMessageInput): Promise<unknown>;
  /** runs.queue */
  queueFollowup(input: RunMessageInput): Promise<unknown>;
  /** runs.retry */
  retry(id: string): Promise<unknown>;
  /** runs.events */
  listEvents(id: string): Promise<unknown>;
  /** spend.get */
  spend(): Promise<unknown>;
  /** repos.list */
  listRepos(): Promise<unknown>;
  /** metrics.get */
  getMetrics(): Promise<unknown>;
}
```

## tests/contract.test.ts
```
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHttpClient } from "../src/http-client.js";

interface Route {
  method: string;
  path: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/factory-routes.json", import.meta.url), "utf8"),
) as { source: string; routes: Route[] };

/** Arguments for each client method. A method with no entry fails the test. */
const SAMPLES: Record<string, unknown[]> = {
  listTasks: [],
  getTask: ["ID"],
  createTask: [{ title: "t" }],
  handOffTask: [{ id: "ID", to: "z" }],
  approvePlan: ["ID"],
  steer: [{ id: "ID", message: "m" }],
  queueFollowup: [{ id: "ID", message: "m" }],
  retry: ["ID"],
  listEvents: ["ID"],
  spend: [],
  listRepos: [],
  getMetrics: [],
};

/** Calls the client makes today that match no server route. */
const KNOWN_DRIFT: (Route & { reason: string })[] = [
  { method: "GET", path: "/tasks", reason: "server has no task routes" },
  { method: "GET", path: "/tasks/ID", reason: "server has no task routes" },
  { method: "POST", path: "/tasks", reason: "server has no task routes" },
  { method: "POST", path: "/tasks/ID/hand-off", reason: "server has no task routes" },
  { method: "POST", path: "/runs/ID/approve", reason: "server has no run approve route" },
  { method: "POST", path: "/runs/ID/steer", reason: "server has no run steer route" },
  { method: "POST", path: "/runs/ID/queue", reason: "server has no run queue route" },
  { method: "POST", path: "/runs/ID/retry", reason: "server has no run retry route" },
  { method: "GET", path: "/runs/ID/events", reason: "server has /api/runs/{repo}/{issue}/events" },
  { method: "GET", path: "/spend", reason: "server has /api/spend" },
  { method: "GET", path: "/repos", reason: "server has /api/repos" },
  { method: "GET", path: "/plugins", reason: "server has no plugins route" },
];

function matcher(path: string): RegExp {
  const src = path
    .split("/")
    .map((seg) => (/^\{.+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${src}$`);
}

const matchers = fixture.routes.map((r) => ({ method: r.method, re: matcher(r.path) }));
const onServer = (method: string, path: string) =>
  matchers.some((m) => m.method === method && m.re.test(path));

async function recordCalls(): Promise<{ method: string; path: string; via: string }[]> {
  const calls: { method: string; path: string; via: string }[] = [];
  let current = "";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, via: current });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = createHttpClient("http://x", "tok", fetchImpl) as unknown as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;
  for (const name of Object.keys(client)) {
    const args = SAMPLES[name];
    assert.ok(args, `client method ${name} has no entry in SAMPLES`);
    current = name;
    await client[name](...args);
  }
  return calls;
}

test("contract: every client call matches a server route or is in KNOWN_DRIFT", async () => {
  const calls = await recordCalls();
  for (const c of calls) {
    const drift = KNOWN_DRIFT.some((d) => d.method === c.method && d.path === c.path);
    assert.ok(
      onServer(c.method, c.path) || drift,
      `${c.via}: ${c.method} ${c.path} is neither a server route nor in KNOWN_DRIFT`,
    );
  }
});

test("contract: no KNOWN_DRIFT entry matches a server route", () => {
  for (const d of KNOWN_DRIFT) {
    assert.ok(!onServer(d.method, d.path), `KNOWN_DRIFT ${d.method} ${d.path} now matches a server route; remove it`);
  }
});

const liveUrl = process.env.FACTORY_SERVE_URL;
const liveToken = process.env.FACTORY_API_TOKEN;

test(
  "contract: live GET routes without parameters return 200",
  { skip: !liveUrl || !liveToken ? "FACTORY_SERVE_URL and FACTORY_API_TOKEN not set" : false },
  async () => {
    const base = (liveUrl ?? "").replace(/\/+$/, "");
    for (const r of fixture.routes.filter((x) => x.method === "GET" && !x.path.includes("{"))) {
      const res = await fetch(`${base}${r.path}`, { headers: { authorization: `Bearer ${liveToken}` } });
      assert.equal(res.status, 200, `GET ${r.path}`);
    }
  },
);
```

## tests/http.test.ts
```
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { startHttp } from "../src/http.js";
import { TOOLS } from "../src/tools.js";
import { fakeClient } from "./fake-client.js";

const TOKEN = "secret-token";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

test("http: no token or a wrong token gets 401; the right token is let through", async () => {
  const h = await startHttp(buildServer(fakeClient()), { port: 0, token: TOKEN });
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(h.url, { method: "POST", headers, body: JSON.stringify(INIT) });
    assert.equal(none.status, 401);
    assert.equal(await none.text(), "unauthorized");
    const wrong = await fetch(h.url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: JSON.stringify(INIT) });
    assert.equal(wrong.status, 401);
    const basic = await fetch(h.url, { method: "POST", headers: { ...headers, authorization: TOKEN }, body: JSON.stringify(INIT) });
    assert.equal(basic.status, 401);
    const ok = await fetch(h.url, { method: "POST", headers: { ...headers, authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(INIT) });
    assert.equal(ok.status, 200);
    await ok.body?.cancel();
  } finally {
    await h.close();
  }
});

test("http: with the token, tools/list answers every tool and a tool call works", async () => {
  const h = await startHttp(buildServer(fakeClient()), { port: 0, token: TOKEN });
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort());
    const res = await client.callTool({ name: "list_tasks", arguments: {} });
    assert.match(JSON.stringify(res.content), /first/);
  } finally {
    await client.close();
    await h.close();
  }
});

test("http: an empty token is refused at startup", async () => {
  await assert.rejects(startHttp(buildServer(fakeClient()), { port: 0, token: "" }), /token/);
});

test("http: the bearer check is the single line in src/http.ts", () => {
  const src = readFileSync(new URL("../../src/http.ts", import.meta.url), "utf8");
  const line =
    'if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });';
  assert.equal(src.split("\n").filter((l) => l.trim() === line).length, 1);
});

test("bin reads credentials from env only and offers --http --port", () => {
  const bin = readFileSync(new URL("../../bin/factory-mcp.ts", import.meta.url), "utf8");
  assert.match(bin, /process\.env\.FACTORY_URL/);
  assert.match(bin, /process\.env\.FACTORY_API_TOKEN/);
  assert.match(bin, /--http/);
  assert.match(bin, /--port/);
  assert.doesNotMatch(bin, /argv[^\n]*(token|TOKEN)/);
});
```

## tests/fixtures/factory-routes.json
```
{
  "source": "KaaS-team/KaaS-factory src/api/openapi.json at 1df7fd9fccf82818094f48bb92caab0b98245bf0",
  "routes": [
    { "method": "GET", "path": "/api/health" },
    { "method": "GET", "path": "/api/repos" },
    { "method": "GET", "path": "/api/runs" },
    { "method": "GET", "path": "/api/runs/{repo}/{issue}" },
    { "method": "GET", "path": "/api/runs/{repo}/{issue}/events" },
    { "method": "GET", "path": "/api/spend" },
    { "method": "GET", "path": "/api/metrics" },
    { "method": "GET", "path": "/api/events" }
  ]
}
```
