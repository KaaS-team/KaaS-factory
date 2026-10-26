// One MCP tool call over stdio, with no agent in the loop: a workflow's `tool` step. JSON-RPC 2.0,
// one message per line (the MCP stdio transport): initialize, initialized, tools/call, then the
// server is stopped. `${VAR}` in the server's args and env expands from the runner's env.

import { McpError, mcpServersFor } from "./mcp";

export interface ToolCallResult {
  readonly ok: boolean;
  readonly text: string;
  readonly content: unknown;
}

const expand = (s: string, env: Record<string, string | undefined>): string =>
  s.replace(/\$\{(\w+)\}/g, (_, k: string) => env[k] ?? "");

export async function callMcpTool(
  dir: string,
  spec: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs = 60_000,
  env: Record<string, string | undefined> = process.env,
): Promise<ToolCallResult> {
  const [server, tool] = spec.split("/") as [string, string];
  const entry = mcpServersFor(dir, [server])[server] as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  if (typeof entry?.command !== "string") throw new McpError(`"${server}" in .factory/mcp.json has no stdio command`);
  const proc = Bun.spawn([entry.command, ...(entry.args ?? []).map((a) => expand(a, env))], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...env, ...Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, expand(v, env)])) },
  });
  const send = (msg: object) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "factory", version: "1" } },
    });
    const reader = proc.stdout.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new McpError(`${spec}: the server exited before answering`);
      buf += new TextDecoder().decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) return { ok: false, text: msg.error.message, content: null };
          const content = msg.result?.content;
          const text = Array.isArray(content)
            ? content.map((c: { text?: string }) => c.text ?? "").join("\n")
            : JSON.stringify(msg.result ?? null);
          return { ok: msg.result?.isError !== true, text, content: content ?? msg.result };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}
