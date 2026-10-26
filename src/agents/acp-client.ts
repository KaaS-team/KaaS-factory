// The one Agent Client Protocol client (agentclientprotocol.com, protocol v1): it starts an ACP
// server, speaks JSON-RPC to it over stdio and runs one prompt turn. src/agents/acp-bridge.ts is its
// only caller; tests/acp-seam.test.ts checks no other module speaks the protocol or starts the server.

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ACP_PROTOCOL_VERSION = 1;

export interface ToolCall {
  kind?: string;
  title?: string;
}
export interface PermissionOption {
  optionId: string;
  kind: string;
}
export interface PermissionRequest {
  toolCall?: ToolCall;
  subject?: { toolCall?: ToolCall };
  options?: PermissionOption[];
}
export type Outcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
export interface Update {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  kind?: string;
  title?: string;
}
interface Rpc {
  id?: number;
  method?: string;
  params?: PermissionRequest & { update?: Update };
  result?: { sessionId?: string; stopReason?: string; usage?: Record<string, unknown>; protocolVersion?: unknown };
  error?: { message?: string };
}

// What the client does with the agent's own requests during a turn.
export interface TurnHandlers {
  onUpdate(update: Update | undefined): void;
  onPermission(req: PermissionRequest): { outcome: Outcome };
}

export interface TurnResult {
  readonly stopReason?: string;
  readonly usage?: Record<string, unknown>;
}

// The client must check the version the agent picked and disconnect from one it does not speak
// (ACP initialization, version negotiation); a v2-only agent's updates would be misread as v1.
export function versionProblem(picked: unknown): string | undefined {
  return picked === ACP_PROTOCOL_VERSION
    ? undefined
    : `acp: the agent answered protocol version ${JSON.stringify(picked)}, and this client speaks only ${ACP_PROTOCOL_VERSION}`;
}

export class AcpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: Rpc["result"]) => void; reject: (e: Error) => void }>();
  private next = 0;
  private handlers?: TurnHandlers;
  readonly exited: Promise<number>;

  // Its own process group, so stop() reaches the agent and anything it started.
  constructor(argv: readonly string[], cwd: string) {
    this.child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "inherit"], detached: true });
    this.exited = new Promise<number>((resolve) => this.child.on("exit", (code) => resolve(code ?? 1)));
    this.child.on("exit", () => this.failAll(new Error("acp: the agent exited before it answered")));
    this.child.on("error", (err) => this.failAll(err));
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.receive(line));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
  }

  private send(msg: object): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  }

  private call(method: string, params: object): Promise<Rpc["result"]> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private receive(line: string): void {
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === undefined && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`acp: ${msg.error.message ?? "request failed"}`));
      else p?.resolve(msg.result);
    } else if (msg.method === "session/update") this.handlers?.onUpdate(msg.params?.update);
    else if (msg.method === "session/request_permission" && this.handlers)
      this.send({ id: msg.id, result: this.handlers.onPermission(msg.params ?? {}) });
    else if (msg.id !== undefined)
      // The client advertises no fs or terminal capability, so the agent uses its own tools.
      this.send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not offered by this client` } });
  }

  // initialize, session/new, then one session/prompt with the text as a single block.
  async runTurn(cwd: string, prompt: string, handlers: TurnHandlers): Promise<TurnResult> {
    this.handlers = handlers;
    const init = await this.call("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const wrong = versionProblem(init?.protocolVersion);
    if (wrong) throw new Error(wrong);
    const sessionId = (await this.call("session/new", { cwd, mcpServers: [] }))?.sessionId;
    const res = await this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    return { stopReason: res?.stopReason, usage: res?.usage };
  }

  async stop(): Promise<number> {
    this.child.stdin!.end();
    try {
      process.kill(-this.child.pid!, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
    return this.exited;
  }
}
