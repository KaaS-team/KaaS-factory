// The dial-out protocol on the plane side. A runner opens GET /runner/stream with its secret and
// reads its events in order (SSE, resumed by Last-Event-ID); it answers on POST /runner/events.
// The runner routes skip the session gate (PUBLIC_ROUTES) because each one checks the secret itself.
import type { ScmPort } from "../../src/github";
import { signedBy } from "../../src/chatops";
import type { Actor, Route } from "./access";
import { senderName } from "./commands";
import { HEARTBEAT_MS, type RunnerHub, type Signal } from "./runners";

export const RUNNER_ROUTES = ["POST /runner/register", "GET /runner/stream", "POST /runner/events"] as const;
const POLL_MS = 250;
const MESSAGE_MAX = 4000;

export interface RunnerDeps {
  hub: RunnerHub;
  github: Pick<ScmPort, "commentIssue">;
  repo: string;
  actorOf: (req: Request) => Actor | undefined;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>;
const secretOf = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");

function stream(hub: RunnerHub, runner: string, req: Request, url: URL): Response {
  let after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  let poll: Timer | undefined;
  let beat: Timer | undefined;
  const stop = () => {
    clearInterval(poll);
    clearInterval(beat);
  };
  const body = new ReadableStream({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          stop();
        }
      };
      const flush = () => {
        for (const e of hub.events(runner, after)) {
          send(`id: ${e.seq}\nevent: ${e.type}\ndata: ${e.data}\n\n`);
          after = e.seq;
        }
      };
      flush();
      poll = setInterval(flush, POLL_MS);
      // A comment line keeps proxies from closing a quiet stream.
      beat = setInterval(() => send(": hb\n\n"), HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel: stop,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export function runnerRoutes(deps: RunnerDeps): Route[] {
  const { hub } = deps;
  const authed = (req: Request) => hub.runnerOf(secretOf(req));
  const issueOf = (m: RegExpMatchArray) => Number(m[1]);
  // Stop and takeover go to the tracker first, as every other command does, then to the runner.
  const signal =
    (type: Signal, verb: string): Route["handler"] =>
    async (req, _url, m) => {
      const n = issueOf(m);
      if (!hub.holder(n)) return json({ error: `no runner holds #${n}` }, 409);
      const who = senderName(deps.actorOf(req));
      if (deps.repo) await deps.github.commentIssue(deps.repo, n, signedBy(`Asked the runner to ${verb}.`, who));
      return json({ ok: true, runner: hub.signal(n, type, who) });
    };
  return [
    {
      method: "POST",
      pattern: /^\/runner\/register$/,
      label: "POST /runner/register",
      handler: async (req) => {
        const b = await body(req);
        const out = hub.register(String(b.token ?? ""), String(b.name ?? ""));
        return out ? json(out) : json({ error: "this runner token was used or has expired" }, 401);
      },
    },
    {
      method: "GET",
      pattern: /^\/runner\/stream$/,
      label: "GET /runner/stream",
      handler: (req, url) => {
        const runner = authed(req);
        return runner ? stream(hub, runner, req, url) : json({ error: "unauthorized" }, 401);
      },
    },
    {
      method: "POST",
      pattern: /^\/runner\/events$/,
      label: "POST /runner/events",
      handler: async (req) => {
        const runner = authed(req);
        if (!runner) return json({ error: "unauthorized" }, 401);
        const b = await body(req);
        hub.heartbeat(runner);
        if (b.type === "heartbeat") return json({ ok: true });
        if (b.type === "done") return json({ ok: hub.done(runner, Number(b.issue)) });
        if (b.type === "read") {
          const ok = hub.read(runner, Number(b.id));
          return ok ? json({ ok }) : json({ error: "that message was undone" }, 409);
        }
        return json({ error: "unknown event" }, 400);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/runners\/token$/,
      label: "POST /api/runners/token",
      role: "owner",
      handler: () => json({ token: hub.issueToken() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/runners$/,
      label: "GET /api/runners",
      role: "operator",
      handler: () => {
        hub.sweep();
        return json({ runners: hub.list() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/dispatch$/,
      label: "POST /api/issues/:n/dispatch",
      role: "operator",
      handler: (_req, _url, m) => {
        hub.enqueue(issueOf(m));
        return json({ ok: true, runner: hub.holder(issueOf(m)) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/messages$/,
      label: "GET /api/issues/:n/messages",
      role: "viewer",
      handler: (_req, _url, m) => json({ messages: hub.messages(issueOf(m)) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/message$/,
      label: "POST /api/issues/:n/message",
      role: "operator",
      handler: async (req, _url, m) => {
        const text = String((await body(req)).text ?? "").trim();
        if (!text || text.length > MESSAGE_MAX)
          return json({ error: `a message is 1 to ${MESSAGE_MAX} characters` }, 400);
        return json({ ok: true, id: hub.message(issueOf(m), text, deps.actorOf(req)?.login ?? "") });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/messages\/(\d+)\/undo$/,
      label: "POST /api/issues/:n/messages/:id/undo",
      role: "operator",
      handler: (_req, _url, m) =>
        hub.undo(issueOf(m), Number(m[2])) ? json({ ok: true }) : json({ error: "the runner already read it" }, 409),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/stop$/,
      label: "POST /api/issues/:n/stop",
      role: "operator",
      handler: signal("cancel", "stop"),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/takeover$/,
      label: "POST /api/issues/:n/takeover",
      role: "operator",
      handler: signal("takeover", "hand the running stage over"),
    },
  ];
}
