// Linear's Agent API: the factory installs as an app user (OAuth actor=app), a person delegates or
// mentions it on an issue, and Linear opens an agent session. The receiver acks the webhook at once,
// starts the issue through applySteer, and the watcher posts each stage back as a session activity.

import { createHmac, timingSafeEqual } from "node:crypto";
import { keyNumber, VendorClient } from "../adapters/trackers/kit";
import { InboxError } from "../inbox";
import type { LinkStore } from "./links";
import type { Progress } from "./progress";
import { applySteer, parseSteer, type SteerTracker } from "./steer";

export const LINEAR_AGENT_ENV = { token: "LINEAR_AGENT_TOKEN", secret: "LINEAR_WEBHOOK_SECRET" } as const;
export const SURFACE = "linear-agent";
// Linear retries a webhook it sees no answer to within 5s, and marks a session unresponsive at 10s.
export const ACK_MS = 5_000;
export const FIRST_ACTIVITY_MS = 10_000;
const REPLAY_MS = 60_000;

export function linearOAuthUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
    state: o.state,
  });
  return `https://linear.app/oauth/authorize?${q}`;
}

export function linearSignatureOk(secret: string, body: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface SessionEvent {
  readonly action: "created" | "prompted";
  readonly session: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly prompt: string;
  readonly creator: string;
}

export function parseSessionEvent(raw: unknown): SessionEvent | undefined {
  const p = raw as {
    type?: string;
    action?: string;
    agentSession?: { id?: string; issue?: Record<string, string>; creator?: { name?: string } };
    agentActivity?: { content?: { body?: string } };
  };
  const s = p?.agentSession;
  if (p?.type !== "AgentSessionEvent" || (p.action !== "created" && p.action !== "prompted")) return undefined;
  if (!s?.id || !s.issue?.identifier) return undefined;
  return {
    action: p.action,
    session: s.id,
    key: s.issue.identifier,
    title: s.issue.title ?? s.issue.identifier,
    description: s.issue.description ?? "",
    url: s.issue.url ?? "",
    prompt: p.agentActivity?.content?.body ?? "",
    creator: s.creator?.name ?? "a Linear user",
  };
}

export type ActivityContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string };

// The activity Linear shows for a progress note; a PR link goes to externalUrls instead.
export function activityOf(p: Progress): ActivityContent | undefined {
  if (p.kind === "link") return undefined;
  if (p.kind === "action") return { type: "action", action: p.text, parameter: p.step ?? "" };
  return { type: p.kind, body: p.text };
}

export class LinearAgentClient {
  private readonly http: VendorClient;

  constructor(url = "https://api.linear.app", env: Readonly<Record<string, string | undefined>> = process.env) {
    this.http = new VendorClient("linear", url, LINEAR_AGENT_ENV.token, (t) => ({ authorization: `Bearer ${t}` }), env);
  }

  private gql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    return this.http.request("POST", "/graphql", { body: { query, variables } });
  }

  activity(session: string, content: ActivityContent): Promise<unknown> {
    return this.gql(
      "mutation AgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      { input: { agentSessionId: session, content } },
    );
  }

  // externalUrls carries the PR, plan the stages with their state.
  update(session: string, input: { externalUrls?: { label: string; url: string }[]; plan?: PlanItem[] }) {
    return this.gql(
      "mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
      { id: session, input },
    );
  }
}

export interface PlanItem {
  readonly content: string;
  readonly status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface ReceiverDeps {
  readonly secret: string;
  readonly repo: string;
  readonly tracker: SteerTracker;
  readonly links: LinkStore;
  readonly client: Pick<LinearAgentClient, "activity">;
  // The factory's tracker is this Linear team, so the delegated issue is labelled, not copied.
  readonly sameBoard: boolean;
  // Work that runs after the ack; a test awaits it.
  readonly defer: (work: Promise<void>) => void;
  readonly now?: () => number;
}

export function linearAgentReceiver(deps: ReceiverDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (req) => {
    const body = await req.text();
    if (!linearSignatureOk(deps.secret, body, req.headers.get("linear-signature")))
      return Response.json({ error: "bad signature" }, { status: 401 });
    const raw = JSON.parse(body) as { webhookTimestamp?: number };
    if (typeof raw.webhookTimestamp !== "number" || Math.abs(now() - raw.webhookTimestamp) > REPLAY_MS)
      return Response.json({ error: "stale delivery" }, { status: 401 });
    const e = parseSessionEvent(raw);
    if (!e) return Response.json({ ok: true, ignored: true }, { status: 202 });
    deps.defer(handle(deps, e));
    return Response.json({ ok: true });
  };
}

async function handle(deps: ReceiverDeps, e: SessionEvent): Promise<void> {
  const by = `${e.creator} in Linear`;
  if (e.action === "created") {
    await deps.client.activity(e.session, { type: "thought", body: `Picked up ${e.key}. Starting the factory.` });
    const steer = deps.sameBoard
      ? ({ kind: "ready", issue: keyNumber(e.key) } as const)
      : ({ kind: "start", title: e.title, body: [e.description, e.url].filter(Boolean).join("\n\n") } as const);
    const { issue } = await applySteer(deps.tracker, deps.repo, steer, by);
    deps.links.put({ surface: SURFACE, external: e.session, repo: deps.repo, issue });
    return;
  }
  const link = deps.links.byExternal(SURFACE, e.session);
  const steer = link ? parseSteer(e.prompt, link.issue) : undefined;
  if (!link || !steer) return;
  try {
    const { posted } = await applySteer(deps.tracker, deps.repo, steer, by);
    await deps.client.activity(e.session, { type: "thought", body: `Sent to the factory: ${posted.split("\n")[0]}` });
  } catch (err) {
    if (!(err instanceof InboxError)) throw err;
    await deps.client.activity(e.session, { type: "error", body: err.message });
  }
}
