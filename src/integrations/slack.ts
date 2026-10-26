// A Slack assistant app: a person opens the factory's assistant pane or messages it in a thread, and
// the thread becomes the task. The first message starts an issue, later ones steer it (approve,
// revise, answer, cancel), and the watcher replies in the thread as the run moves, with setStatus.

import { createHmac, timingSafeEqual } from "node:crypto";
import { VendorClient } from "../adapters/trackers/kit";
import { InboxError } from "../inbox";
import type { LinkStore } from "./links";
import type { Progress } from "./progress";
import { applySteer, parseSteer, type SteerTracker } from "./steer";

export const SLACK_ENV = { token: "SLACK_BOT_TOKEN", secret: "SLACK_SIGNING_SECRET" } as const;
export const SURFACE = "slack";
const SKEW_S = 300;

export function slackSignatureOk(secret: string, ts: string | null, body: string, sig: string | null, nowS: number) {
  if (!secret || !ts || !sig || Math.abs(nowS - Number(ts)) > SKEW_S) return false;
  const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`);
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

export class SlackClient {
  private readonly http: VendorClient;

  constructor(url = "https://slack.com/api", env: Readonly<Record<string, string | undefined>> = process.env) {
    this.http = new VendorClient("slack", url, SLACK_ENV.token, (t) => ({ authorization: `Bearer ${t}` }), env);
  }

  // Slack answers 200 with ok: false on a refused call, so ok is checked here.
  async call(method: string, body: Record<string, unknown>): Promise<void> {
    const r = await this.http.request<{ ok?: boolean; error?: string }>("POST", `/${method}`, { body });
    if (!r.ok) throw new Error(`slack ${method}: ${r.error ?? "not ok"}`);
  }

  setStatus(channel: string, thread: string, status: string): Promise<void> {
    return this.call("assistant.threads.setStatus", { channel_id: channel, thread_ts: thread, status });
  }

  reply(channel: string, thread: string, text: string): Promise<void> {
    return this.call("chat.postMessage", { channel, thread_ts: thread, text });
  }
}

export interface SlackDeps {
  readonly secret: string;
  readonly repo: string;
  readonly tracker: SteerTracker;
  readonly links: LinkStore;
  readonly client: Pick<SlackClient, "setStatus" | "reply" | "call">;
  readonly defer: (work: Promise<void>) => void;
  readonly nowS?: () => number;
}

interface SlackEvent {
  type?: string;
  channel?: string;
  thread_ts?: string;
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  assistant_thread?: { channel_id?: string; thread_ts?: string };
}

export function slackReceiver(deps: SlackDeps): (req: Request) => Promise<Response> {
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  return async (req) => {
    const body = await req.text();
    const h = (k: string) => req.headers.get(k);
    if (!slackSignatureOk(deps.secret, h("x-slack-request-timestamp"), body, h("x-slack-signature"), nowS()))
      return Response.json({ error: "bad signature" }, { status: 401 });
    const p = JSON.parse(body) as { type?: string; challenge?: string; event?: SlackEvent };
    if (p.type === "url_verification") return Response.json({ challenge: p.challenge });
    const e = p.event;
    if (p.type !== "event_callback" || !e) return Response.json({ ok: true, ignored: true }, { status: 202 });
    deps.defer(handle(deps, e));
    return Response.json({ ok: true });
  };
}

async function handle(deps: SlackDeps, e: SlackEvent): Promise<void> {
  if (e.type === "assistant_thread_started" && e.assistant_thread?.channel_id && e.assistant_thread.thread_ts) {
    await deps.client.call("assistant.threads.setSuggestedPrompts", {
      channel_id: e.assistant_thread.channel_id,
      thread_ts: e.assistant_thread.thread_ts,
      prompts: [{ title: "Start a task", message: "start: " }],
    });
    return;
  }
  // The bot's own replies come back as messages too; only a person's text steers. The signature names
  // the user id bare: a `<@U1>` mention would stop unsigned() from stripping it off an answer.
  if (e.type !== "message" || e.bot_id || e.subtype || !e.channel || !e.text) return;
  const thread = e.thread_ts ?? e.ts ?? "";
  const external = `${e.channel}:${thread}`;
  const link = deps.links.byExternal(SURFACE, external);
  const steer = parseSteer(e.text, link?.issue);
  if (!steer) return;
  await deps.client.setStatus(e.channel, thread, "is sending that to the factory...");
  try {
    const { issue, posted } = await applySteer(deps.tracker, deps.repo, steer, `Slack user ${e.user ?? "unknown"}`);
    if (!link) deps.links.put({ surface: SURFACE, external, repo: deps.repo, issue });
    await deps.client.reply(
      e.channel,
      thread,
      steer.kind === "start" ? `Started #${issue}.` : `Sent: ${posted.split("\n")[0]}`,
    );
  } catch (err) {
    if (!(err instanceof InboxError)) throw err;
    await deps.client.reply(e.channel, thread, err.message);
  }
}

// The watcher's side: a progress note becomes a thread reply, and the status shows the running step.
export async function slackProgress(client: Pick<SlackClient, "setStatus" | "reply">, external: string, p: Progress) {
  const [channel = "", thread = ""] = external.split(":");
  await client.setStatus(channel, thread, p.done || p.kind !== "action" ? "" : `is ${p.text.toLowerCase()}`);
  if (p.kind !== "action") await client.reply(channel, thread, p.url ? `${p.text}: ${p.url}` : p.text);
}
