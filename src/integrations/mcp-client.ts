// The smallest MCP client the factory needs: Streamable HTTP, initialize then tools/call. It backs
// three things: the MCP notifier (progress as a tool call), the MCP event source (a tool that returns
// events) and a workflow's `uses: mcp` step. stdio servers stay the agent's; this speaks HTTP only.

import { type CloudEvent, isExternalEventType, parseEvent } from "../core/event";
import type { BusEventRow } from "../state";
import type { Progress } from "./progress";

export const MCP_ENV = {
  notifyUrl: "FACTORY_MCP_NOTIFY_URL",
  notifyTool: "FACTORY_MCP_NOTIFY_TOOL",
  eventsUrl: "FACTORY_MCP_EVENTS_URL",
  eventsTool: "FACTORY_MCP_EVENTS_TOOL",
  token: "FACTORY_MCP_TOKEN",
} as const;
const PROTOCOL = "2025-06-18";

export interface ToolResult {
  readonly isError?: boolean;
  readonly content?: readonly { type: string; text?: string }[];
  readonly structuredContent?: unknown;
}

export class McpClient {
  private session: string | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  // A JSON answer, or the matching message out of an SSE stream; both are allowed by the spec.
  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const id = notify ? undefined : this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
    });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    const text = await res.text();
    if (!res.ok) throw new Error(`mcp ${method} answered ${res.status}`);
    if (notify) return undefined;
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const msg = messages.find((m: { id?: number }) => m.id === id) as { result?: unknown; error?: { message: string } };
    if (!msg) throw new Error(`mcp ${method}: no answer`);
    if (msg.error) throw new Error(`mcp ${method}: ${msg.error.message}`);
    return msg.result;
  }

  private init(): Promise<void> {
    return (this.ready ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "kaas-factory", version: "1" },
      });
      await this.rpc("notifications/initialized", {}, true);
    })());
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.init();
    return (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
  }
}

export const bearer = (token: string | undefined): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

// The notifier: each progress note is one call of the configured tool.
export async function notifyMcp(client: McpClient, tool: string, p: Progress): Promise<void> {
  const r = await client.callTool(tool, { ...p });
  if (r.isError) throw new Error(`mcp tool ${tool} refused the notification`);
}

// The event source: the tool returns CloudEvents (structuredContent.events, or JSON text). Only other
// apps' types count, the same rule POST /events applies, so a tool cannot fake a factory event.
export async function pullMcpEvents(client: McpClient, tool: string): Promise<CloudEvent[]> {
  const r = await client.callTool(tool, {});
  const sc = r.structuredContent as { events?: unknown } | undefined;
  const raw = sc?.events ?? JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? "[]");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const parsed = parseEvent(e);
    return parsed.ok && isExternalEventType(parsed.event.type) ? [parsed.event] : [];
  });
}

// Stored exactly as POST /events stores a delivery, so the watcher hands them on the same way.
export async function recordMcpEvents(
  client: McpClient,
  tool: string,
  state: { recordBusEvent: (row: BusEventRow) => boolean },
): Promise<number> {
  let fresh = 0;
  for (const e of await pullMcpEvents(client, tool)) {
    const row = { id: e.id, direction: "in", type: e.type, source: e.source, subject: e.subject ?? null } as const;
    if (state.recordBusEvent({ ...row, time: e.time, data: JSON.stringify(e.data), handled_at: null })) fresh++;
  }
  return fresh;
}
