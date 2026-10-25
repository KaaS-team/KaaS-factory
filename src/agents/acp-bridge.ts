// Runs one stage against an Agent Client Protocol server (agentclientprotocol.com, protocol v1) and
// prints one StageEvent per line for the acp preset. Usage: `bun acp-bridge.ts <read|write> <cwd> --
// <agent argv>`, prompt on stdin. Notes on the protocol: docs/agent-research/acp/protocol.md.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { StageEvent } from "../executor";

// Tool kinds a read-only stage may run. Anything else (edit, delete, move, execute, fetch, other) is refused.
export const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);

interface PermissionOption {
  optionId: string;
  kind: string;
}
type Outcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
interface Update {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  kind?: string;
  title?: string;
}
// One JSON-RPC message from the agent: a reply to the bridge, or a request or notification of its own.
interface Rpc {
  id?: number;
  method?: string;
  params?: PermissionRequest & { update?: Update };
  result?: { sessionId?: string; stopReason?: string; usage?: Record<string, unknown> };
  error?: { message?: string };
}
interface PermissionRequest {
  toolCall?: { kind?: string; title?: string };
  subject?: { toolCall?: { kind?: string; title?: string } };
  options?: PermissionOption[];
}

// An agent asks before a tool runs; a read-only stage allows only READ_KINDS. Without a matching option it cancels.
export function decide(req: PermissionRequest, write: boolean): { allowed: boolean; result: { outcome: Outcome } } {
  const call = req.toolCall ?? req.subject?.toolCall;
  const allowed = write || READ_KINDS.has(call?.kind ?? "");
  const want = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const opt = want.map((k) => req.options?.find((o) => o.kind === k)).find(Boolean);
  const outcome: Outcome = opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
  return { allowed, result: { outcome } };
}

// One session/update notification as the events the runner aggregates.
export function updateEvents(update: Update | undefined): StageEvent[] {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text" ? [{ kind: "text", text: String(update.content.text) }] : [];
    case "tool_call":
      return [{ kind: "tool_use", toolName: String(update.kind ?? "other"), toolTarget: update.title }];
    default:
      return [];
  }
}

// PromptResponse.usage is an optional field of the protocol; an agent that omits it reports no tokens.
export function usageEvent(usage: Record<string, unknown> | undefined): StageEvent {
  const n = (k: string) => (typeof usage?.[k] === "number" ? (usage[k] as number) : undefined);
  const tokensIn = n("inputTokens");
  const tokensOut = n("outputTokens");
  if (tokensIn === undefined || tokensOut === undefined) return { kind: "usage", invalid: true };
  return { kind: "usage", tokensIn, tokensOut, tokensCached: n("cachedReadTokens") ?? 0, total: true };
}

export async function runBridge(write: boolean, cwd: string, argv: string[], prompt: string): Promise<number> {
  const out = (e: StageEvent) => process.stdout.write(`${JSON.stringify(e)}\n`);
  const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, { resolve: (v: Rpc["result"]) => void; reject: (e: Error) => void }>();
  let next = 0;
  const send = (msg: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const call = (method: string, params: object) =>
    new Promise<Rpc["result"]>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  child.on("exit", () => {
    for (const p of pending.values()) p.reject(new Error("acp: the agent exited before it answered"));
  });
  child.on("error", (err) => {
    for (const p of pending.values()) p.reject(err);
  });

  let message = "";
  const denials: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === undefined && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`acp: ${msg.error.message ?? "request failed"}`));
      else p?.resolve(msg.result);
    } else if (msg.method === "session/update") {
      for (const e of updateEvents(msg.params?.update)) {
        if (e.kind === "text") message += e.text;
        out(e);
      }
    } else if (msg.method === "session/request_permission") {
      const d = decide(msg.params ?? {}, write);
      const call = msg.params?.toolCall ?? msg.params?.subject?.toolCall;
      if (!d.allowed) denials.push(`${call?.kind ?? "other"} ${call?.title ?? ""}`.trim());
      send({ id: msg.id, result: d.result });
    } else if (msg.id !== undefined) {
      // The client advertises no fs or terminal capability, so the agent uses its own tools.
      send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not offered by this client` } });
    }
  });

  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const sessionId = (await call("session/new", { cwd, mcpServers: [] }))?.sessionId;
    const res = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    out(usageEvent(res?.usage));
    out({ kind: "result", finalText: message, denials });
    child.stdin.end();
    child.kill();
    return res?.stopReason === "end_turn" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    child.kill();
    await exited;
    return 1;
  }
}

if (import.meta.main) {
  const [mode, cwd, sep, ...argv] = process.argv.slice(2);
  if ((mode !== "read" && mode !== "write") || !cwd || sep !== "--" || argv.length === 0) {
    process.stderr.write("usage: acp-bridge.ts <read|write> <cwd> -- <agent argv>\n");
    process.exit(2);
  }
  process.exit(await runBridge(mode === "write", cwd, argv, await new Response(Bun.stdin.stream()).text()));
}
