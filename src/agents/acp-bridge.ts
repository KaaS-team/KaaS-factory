// Runs one stage against an Agent Client Protocol server (agentclientprotocol.com, protocol v1) and
// prints one StageEvent per line for the acp preset. Usage: `bun acp-bridge.ts <read|write> <cwd> --
// <agent argv>`, prompt on stdin. Notes on the protocol: docs/agent-research/acp/protocol.md.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { StageEvent } from "../executor";
import { AcpClient, type Outcome, type PermissionRequest, type Update } from "./acp-client";

// Tool kinds a read-only stage may run. Anything else (edit, delete, move, execute, fetch, other) is refused.
export const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);

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

// Tool kinds are the agent's own claim, so a read-only stage also checks that no file in the
// worktree changed: by content hash, since size and mtime can be put back. Under node_modules,
// too big to hash twice per stage, size, mode and change time count (ctime cannot be set back).
export function treeStamp(root: string, rel = "", deps = false): Map<string, string> {
  const stamp = new Map<string, string>();
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    const full = join(root, p);
    if (e.isDirectory()) {
      for (const [k, v] of treeStamp(root, p, deps || e.name === "node_modules")) stamp.set(k, v);
    } else if (e.isSymbolicLink()) stamp.set(p, `link:${readlinkSync(full)}`);
    else if (deps) {
      const s = lstatSync(full);
      stamp.set(p, `${s.size}:${s.mode}:${s.ctimeMs}`);
    } else stamp.set(p, createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return stamp;
}

export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

export async function runBridge(write: boolean, cwd: string, argv: string[], prompt: string): Promise<number> {
  const out = (e: StageEvent) => process.stdout.write(`${JSON.stringify(e)}\n`);
  const before = write ? undefined : treeStamp(cwd);
  const client = new AcpClient(argv, cwd);
  let message = "";
  const denials: string[] = [];
  try {
    const res = await client.runTurn(cwd, prompt, {
      onUpdate: (update) => {
        for (const e of updateEvents(update)) {
          if (e.kind === "text") message += e.text;
          out(e);
        }
      },
      onPermission: (req) => {
        const d = decide(req, write);
        const call = req.toolCall ?? req.subject?.toolCall;
        if (!d.allowed) denials.push(`${call?.kind ?? "other"} ${call?.title ?? ""}`.trim());
        return d.result;
      },
    });
    out(usageEvent(res.usage));
    await client.stop();
    const moved = before ? changedPaths(before, treeStamp(cwd)) : [];
    if (moved.length) {
      process.stderr.write(`acp: a read-only stage changed ${moved.slice(0, 5).join(", ")}\n`);
      return 1;
    }
    out({ kind: "result", finalText: message, denials });
    return res.stopReason === "end_turn" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    await client.stop();
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
