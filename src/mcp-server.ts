// The factory as an MCP server: newline-delimited JSON-RPC on stdio, so any agent or IDE can
// start, read and approve tasks. Every write goes through the same tracker-first path as the
// CLI inbox and the plane (act(), signedBy), so the tracker stays the one record.
import { act, buildInbox, InboxError } from "./inbox";
import { LABEL } from "./labels";
import { signedBy } from "./chatops";
import { prItems } from "./stale-pr";
import type { ScmPort } from "./ports/scm";

export const MCP_PROTOCOL = "2025-06-18";

export interface McpDeps {
  github: Pick<ScmPort, "listOpenIssues" | "getIssue" | "commentIssue" | "createIssue" | "listPrs">;
  repo: string;
  // Who the comments name, since they go out under the runner's tracker account.
  by: string;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const issueArg = { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"] };

function issueOf(args: Record<string, unknown>): number {
  const n = Number(args.issue);
  if (!Number.isInteger(n) || n <= 0) throw new InboxError("issue must be a positive integer");
  return n;
}

export function mcpTools(deps: McpDeps): Tool[] {
  const { github, repo, by } = deps;
  return [
    {
      name: "list_tasks",
      description: "List what is waiting for a human (plans to approve, questions, parked runs).",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        const items = [
          ...buildInbox(await github.listOpenIssues(repo)),
          ...prItems(await github.listPrs(repo, { state: "open" })),
        ];
        return items.map((i) => ({ issue: i.issue, kind: i.kind, title: i.title, actions: i.actions }));
      },
    },
    {
      name: "read_task",
      description: "Read one task: its title, body, labels and the latest comments.",
      inputSchema: issueArg,
      call: async (args) => {
        const issue = await github.getIssue(repo, issueOf(args));
        const comments = (issue.comments ?? []).slice(-5).map((c) => c.body);
        return {
          issue: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels.map((l) => l.name),
          comments,
        };
      },
    },
    {
      name: "start_task",
      description: "File a task labelled ready, so the factory picks it up.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"],
      },
      call: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title || title.length > 256) throw new InboxError("title must be 1 to 256 characters");
        const body = typeof args.body === "string" ? args.body.trim() : "";
        const issue = await github.createIssue(repo, title, signedBy(body, by), [LABEL.ready]);
        return { issue };
      },
    },
    {
      name: "approve_plan",
      description: "Approve the plan on a task waiting for approval.",
      inputSchema: issueArg,
      call: async (args) => {
        const n = issueOf(args);
        // Read fresh, as the plane does: a stale state could approve what no longer waits.
        const item = buildInbox([await github.getIssue(repo, n)])[0];
        if (!item) throw new InboxError(`#${n} is not waiting for you`);
        return { issue: n, posted: await act(github, repo, item, "approve", "", by) };
      },
    },
  ];
}

export function createMcpServer(deps: McpDeps) {
  const tools = mcpTools(deps);
  const reply = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcMessage["id"], code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  async function handle(msg: RpcMessage): Promise<object | undefined> {
    // A notification has no id and never gets a reply.
    if (msg.id === undefined || msg.id === null) return undefined;
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return reply(msg.id, {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "kaas-factory", version: "1" },
        });
      case "ping":
        return reply(msg.id, {});
      case "tools/list":
        return reply(msg.id, {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return fail(msg.id, -32602, `unknown tool ${String(params.name)}`);
        try {
          const out = await tool.call((params.arguments ?? {}) as Record<string, unknown>);
          return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }], isError: false });
        } catch (err) {
          // A refused command is a tool result the agent can read, not a protocol error.
          if (err instanceof InboxError)
            return reply(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
          throw err;
        }
      }
      default:
        return fail(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  return { handle, tools };
}

export async function serveStdio(
  server: ReturnType<typeof createMcpServer>,
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of input) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      const out = await server.handle(msg);
      if (out) write(`${JSON.stringify(out)}\n`);
    }
  }
}
