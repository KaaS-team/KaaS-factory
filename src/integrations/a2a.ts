// A2A: another agent hands the factory a task over JSON-RPC, reads its state and steers it. Opt-in,
// never a default: with FACTORY_A2A_TOKEN unset the card and the endpoint are 404. A message starts
// an issue through applySteer; a message on a known task steers it, like a comment would.

import { timingSafeEqual } from "node:crypto";
import { InboxError } from "../inbox";
import { LABEL } from "../labels";
import type { LinkStore } from "./links";
import { applySteer, parseSteer, type SteerTracker } from "./steer";

export const A2A_ENV = { token: "FACTORY_A2A_TOKEN" } as const;
export const SURFACE = "a2a";

export function agentCard(baseUrl: string, version: string) {
  return {
    protocolVersion: "0.3.0",
    name: "KaaS Factory",
    description: "Turns a task into a reviewed pull request: triage, plan, build, verify, PR.",
    url: `${baseUrl.replace(/\/+$/, "")}/a2a`,
    version,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    skills: [
      { id: "start-task", name: "Start a task", description: "Files a task the factory picks up.", tags: ["coding"] },
      { id: "steer", name: "Steer a task", description: "approve, revise, answer or cancel.", tags: ["coding"] },
    ],
  };
}

type State = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
// The issue's labels, as an A2A task state.
export function taskState(labels: readonly string[], closed: boolean): State {
  if (labels.includes(LABEL.awaitingApproval) || labels.includes(LABEL.needsInfo)) return "input-required";
  if (labels.includes(LABEL.failed)) return "failed";
  if (closed) return "completed";
  return labels.includes(LABEL.ready) ? "submitted" : "working";
}

export interface A2aDeps {
  readonly token: string;
  readonly repo: string;
  readonly tracker: SteerTracker;
  readonly links: LinkStore;
}

const rpcError = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

export function bearerOk(token: string, header: string | null): boolean {
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return token !== "" && got.length === want.length && timingSafeEqual(got, want);
}

export async function a2aRpc(deps: A2aDeps, req: Request): Promise<Response> {
  if (!bearerOk(deps.token, req.headers.get("authorization")))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const call = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    method?: string;
    params?: { id?: unknown; message?: unknown };
  };
  const task = async (issue: number) => {
    const i = await deps.tracker.getIssue(deps.repo, issue);
    const labels = i.labels.map((l) => l.name);
    return {
      kind: "task",
      id: String(issue),
      contextId: String(issue),
      status: { state: taskState(labels, i.state === "CLOSED") },
    };
  };
  if (call.method === "tasks/get") {
    const link = deps.links.byExternal(SURFACE, String(call.params?.id ?? ""));
    return link
      ? Response.json({ jsonrpc: "2.0", id: call.id, result: await task(link.issue) })
      : rpcError(call.id, -32001, "task not found");
  }
  if (call.method !== "message/send") return rpcError(call.id, -32601, "method not found");
  const msg = call.params?.message as { taskId?: string; parts?: { kind?: string; text?: string }[] } | undefined;
  const text = (msg?.parts ?? [])
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  const link = msg?.taskId ? deps.links.byExternal(SURFACE, msg.taskId) : undefined;
  if (msg?.taskId && !link) return rpcError(call.id, -32001, "task not found");
  const steer = parseSteer(text, link?.issue);
  if (!steer) return rpcError(call.id, -32602, "the message has no text");
  try {
    const { issue } = await applySteer(deps.tracker, deps.repo, steer, "an A2A client");
    deps.links.put({ surface: SURFACE, external: String(issue), repo: deps.repo, issue });
    return Response.json({ jsonrpc: "2.0", id: call.id, result: await task(issue) });
  } catch (err) {
    if (err instanceof InboxError) return rpcError(call.id, -32002, err.message);
    throw err;
  }
}
