// One MCP tool call over stdio, with no agent in the loop: a workflow's `tool` step. JSON-RPC 2.0,
// one message per line (the MCP stdio transport): initialize, initialized, tools/call, then the
// server is stopped. The server is third-party code, so it gets only toolEnv below, never the
// runner's tokens.

import { gatewaySanitizedEnv } from "./agents/env";
import { McpError, mcpServersFor } from "./mcp";

export interface ToolCallResult {
  readonly ok: boolean;
  readonly text: string;
  readonly content: unknown;
}

const BASE_ENV = ["PATH", "HOME", "TMPDIR", "LANG"];
const expand = (s: string, env: Record<string, string | undefined>): string =>
  s.replace(/\$\{(\w+)\}/g, (_, k: string) => env[k] ?? "");

// What a tool's server sees: PATH, HOME, TMPDIR, LANG and the keys its mcp.json `env` names.
// `${VAR}` expands only from the names the step's `env:` declares, and never to a runner token,
// provider key or other credential, even when declared.
export function toolEnv(
  env: Record<string, string | undefined>,
  declared: readonly string[],
  entryEnv: Readonly<Record<string, string>> = {},
): { vars: Record<string, string>; child: Record<string, string> } {
  const safe = gatewaySanitizedEnv(env);
  const vars = Object.fromEntries(declared.filter((k) => safe[k] !== undefined).map((k) => [k, safe[k]!]));
  const child = Object.fromEntries(BASE_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]!]));
  for (const [k, v] of Object.entries(entryEnv)) child[k] = expand(v, vars);
  return { vars, child };
}

export async function callMcpTool(
  dir: string,
  spec: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs = 60_000,
  declared: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<ToolCallResult> {
  const [server, tool] = spec.split("/") as [string, string];
  const entry = mcpServersFor(dir, [server])[server] as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  if (typeof entry?.command !== "string") throw new McpError(`"${server}" in .factory/mcp.json has no stdio command`);
  const { vars, child } = toolEnv(env, declared, entry.env);
  const proc = Bun.spawn([entry.command, ...(entry.args ?? []).map((a) => expand(a, vars))], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: child,
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
