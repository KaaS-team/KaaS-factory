// The outside surfaces' doors into the plane: Linear's agent webhook, Slack's events, A2A and AG-UI.
// Each route answers 404 until its env key is set, so a plane with none set exposes nothing new.
// Linear and Slack sign their deliveries and A2A carries a bearer token, so each checks its own caller.
import type { FactoryState } from "../../src/state";
import { a2aRpc, A2A_ENV, agentCard } from "../../src/integrations/a2a";
import { AGUI_ENV, aguiEvents, sse } from "../../src/integrations/agui";
import { LINEAR_AGENT_ENV, LinearAgentClient, linearAgentReceiver } from "../../src/integrations/linear-agent";
import { LinkStore } from "../../src/integrations/links";
import { SLACK_ENV, SlackClient, slackReceiver } from "../../src/integrations/slack";
import { type SteerTracker, surfaceActors } from "../../src/integrations/steer";
import { EVENT_SIGNATURE_HEADER, isExternalEventType, parseEvent, verifyEvent } from "../../src/core/event";
import { readCapped, WEBHOOK_MAX_BYTES } from "../../src/webhook";
import pkg from "../../package.json";
import type { createAccess, Route } from "./access";
import { resolveRepo } from "./repo-scope";
import type { PlaneStore } from "./store";

export const LINEAR_ROUTE = "POST /integrations/linear";
export const SLACK_ROUTE = "POST /integrations/slack";
export const A2A_CARD_ROUTE = "GET /.well-known/agent-card.json";
export const A2A_ROUTE = "POST /a2a";
// Reached by the vendor or the A2A client, never with a dashboard session; each checks its own caller.
export const INTEGRATION_PUBLIC_ROUTES = [LINEAR_ROUTE, SLACK_ROUTE, A2A_CARD_ROUTE, A2A_ROUTE] as const;

// Other KaaS apps POST CloudEvents here, signed with x-kaas-signature (docs/events.md).
// Public like the other signed routes: it authenticates by HMAC, and is off until the secret is set.
export const EVENTS_ROUTE = "POST /events";

export type Secrets = Record<string, () => string>;

export interface EventsDeps {
  readonly repo: string;
  readonly served: () => string[];
  // The inbound secret of one served repo's own config, and the default's for a repo not served.
  readonly secretFor: (repo: string) => Promise<string>;
  readonly defaultSecret: () => string;
  readonly stateFor: (repo: string) => Pick<FactoryState, "recordBusEvent">;
}

export function eventsRoute(deps: EventsDeps): Route {
  return {
    method: "POST",
    pattern: /^\/events$/,
    label: EVENTS_ROUTE,
    handler: async (req) => {
      if (tooLarge(req)) return Response.json({ error: "too large" }, { status: 413 });
      const bytes = await readCapped(req.body, WEBHOOK_MAX_BYTES);
      if (!bytes) return Response.json({ error: "too large" }, { status: 413 });
      const body = new TextDecoder().decode(bytes);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = undefined;
      }
      // The body is read before it is verified only to pick whose secret verifies it. A repo this
      // plane does not serve is checked against the default's secret, so a 404 never tells a stranger
      // which repos are served.
      const named = (raw as Record<string, Record<string, unknown> | undefined> | null)?.data?.repo;
      const want = typeof named === "string" ? named : "";
      const target = want === "" ? deps.repo : deps.served().find((r) => r.toLowerCase() === want.toLowerCase());
      const served = target !== undefined;
      // Off only while no secret is set anywhere; a served repo with none of its own answers 401 like any
      // other bad signature, so the status never says which repos are served.
      const secret = served ? await deps.secretFor(target) : deps.defaultSecret();
      if (!secret && !deps.defaultSecret()) return notFound();
      if (!verifyEvent(secret, body, req.headers.get(EVENT_SIGNATURE_HEADER)))
        return Response.json({ error: "bad signature" }, { status: 401 });
      if (!served) return Response.json({ error: "unknown repo" }, { status: 404 });
      if (raw === undefined) return Response.json({ error: "body is not JSON" }, { status: 400 });
      const parsed = parseEvent(raw);
      if (!parsed.ok) return Response.json({ error: parsed.problem }, { status: 400 });
      const e = parsed.event;
      if (!isExternalEventType(e.type)) return Response.json({ ok: true, ignored: true }, { status: 202 });
      // Deduped on id: a sender's retry of an event already stored is acknowledged, not re-run.
      const fresh = deps.stateFor(target).recordBusEvent({
        id: e.id,
        direction: "in",
        type: e.type,
        source: e.source,
        subject: e.subject ?? null,
        time: e.time,
        data: JSON.stringify(e.data),
        handled_at: null,
      });
      return Response.json({ ok: true, recorded: fresh }, { status: fresh ? 201 : 200 });
    },
  };
}

export interface IntegrationDeps {
  readonly stateFor: (repo: string) => Pick<FactoryState, "busEvents"> | null;
  // The AG-UI route's repo scope: what the access gate resolved, and which repos the caller may see.
  readonly access: Pick<ReturnType<typeof createAccess>, "repoOf" | "visibleRepos">;
  readonly tracker: SteerTracker;
  readonly repo: string;
  // Every repo this plane serves; `?repo=` may name any of them.
  readonly served: () => string[];
  readonly project?: { readonly config: { readonly tracker: { readonly kind: string } } };
  // Plane members' roles; a Slack or Linear user steers only as the member its allowlist maps it to.
  readonly store: Pick<PlaneStore, "roleOf">;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly links?: () => LinkStore;
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });
// The surfaces carry no repo field yet (A1.7), so each acts on the plane's default and stops without one.
const unbound = () => Response.json({ error: "this plane has no default repo for integrations" }, { status: 409 });
const tooLarge = (req: Request) => Number(req.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES;
// The receivers ack first and finish here, so a slow tracker never makes a vendor retry.
const defer = (work: Promise<void>) =>
  void work.catch((e) => console.error(`integration: ${e instanceof Error ? e.message : String(e)}`));

// A vendor or A2A body is theirs, never a repo selector, so resolveRepo is shown the URL alone.
export async function pickRepo(
  req: Request,
  deps: Pick<IntegrationDeps, "repo" | "served">,
): Promise<string | Response> {
  const named = await resolveRepo(new Request(req.url), "filter", { served: deps.served }, (r) => [...r]);
  return named === "" ? deps.repo : named;
}

const inertTracker = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("repo is not served");
    },
  },
) as SteerTracker;

type Io = { tracker: SteerTracker; defer: typeof defer };

// Credentials are judged before a name's 404 can say whether a repo is served: a request for another
// repo runs the receiver on an inert tracker and only its 401 is passed on, else the refusal is sent.
async function onRepo(
  req: Request,
  deps: Pick<IntegrationDeps, "repo" | "served" | "tracker">,
  run: (repo: string, io: Io) => Promise<Response>,
): Promise<Response> {
  if (tooLarge(req)) return Response.json({ error: "too large" }, { status: 413 });
  const repo = await pickRepo(req, deps);
  if (!(repo instanceof Response)) return repo ? run(repo, { tracker: deps.tracker, defer }) : unbound();
  const probe = await run(deps.repo, { tracker: inertTracker, defer: () => {} }).catch(() => repo);
  return probe.status === 401 ? probe : repo;
}

export function integrationRoutes(deps: IntegrationDeps) {
  const env = deps.env ?? process.env;
  let store: LinkStore | undefined;
  const links = () => (store ??= deps.links?.() ?? new LinkStore());
  const key = (name: string) => env[name] ?? "";
  // A non-loopback caller may reach these with no dashboard token only while the route's own key is set.
  const secrets: Secrets = {
    [LINEAR_ROUTE]: () => key(LINEAR_AGENT_ENV.secret),
    [SLACK_ROUTE]: () => key(SLACK_ENV.secret),
    [A2A_CARD_ROUTE]: () => key(A2A_ENV.token),
    [A2A_ROUTE]: () => key(A2A_ENV.token),
  };
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/integrations\/linear$/,
      label: LINEAR_ROUTE,
      handler: async (req) => {
        const secret = key(LINEAR_AGENT_ENV.secret);
        if (!secret) return notFound();
        const client = new LinearAgentClient(env.LINEAR_AGENT_URL, env);
        const sameBoard = deps.project?.config.tracker.kind === "linear";
        return onRepo(req, deps, (repo, io) =>
          linearAgentReceiver({
            secret,
            repo,
            ...io,
            links: links(),
            client,
            sameBoard,
            actor: surfaceActors(env[LINEAR_AGENT_ENV.users], (login) => deps.store.roleOf(login)),
          })(req),
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/integrations\/slack$/,
      label: SLACK_ROUTE,
      handler: async (req) => {
        const secret = key(SLACK_ENV.secret);
        if (!secret) return notFound();
        const client = new SlackClient(env.SLACK_API_URL, env);
        const actor = surfaceActors(env[SLACK_ENV.users], (login) => deps.store.roleOf(login));
        return onRepo(req, deps, (repo, io) =>
          slackReceiver({ secret, repo, ...io, links: links(), client, actor })(req),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/\.well-known\/agent-card\.json$/,
      label: A2A_CARD_ROUTE,
      handler: (_req, url) => (key(A2A_ENV.token) ? Response.json(agentCard(url.origin, pkg.version)) : notFound()),
    },
    {
      method: "POST",
      pattern: /^\/a2a$/,
      label: A2A_ROUTE,
      handler: async (req) => {
        if (!key(A2A_ENV.token)) return notFound();
        return onRepo(req, deps, (repo, io) =>
          a2aRpc({ token: key(A2A_ENV.token), repo, tracker: io.tracker, links: links() }, req),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/agui\/(\d+)$/,
      label: "GET /api/agui/:n",
      role: "viewer",
      repo: "filter",
      handler: (req, _url, m) => {
        if (!key(AGUI_ENV.on)) return notFound();
        const repo = deps.access.repoOf(req) || deps.repo;
        if (!repo) return unbound();
        if (deps.access.visibleRepos(req, [repo]).length === 0) return notFound();
        const events = (deps.stateFor(repo)?.busEvents(500) ?? []).flatMap((row) => {
          const { subject, ...rest } = row;
          const parsed = parseEvent({
            ...rest,
            ...(subject ? { subject } : {}),
            specversion: "1.0",
            data: JSON.parse(row.data),
          });
          return parsed.ok ? [parsed.event] : [];
        });
        return new Response(sse(aguiEvents(events, repo, Number(m[1]))), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      },
    },
  ];
  // What the Settings page shows: which surfaces are on and the one repo they all act on.
  const surfaces = [
    ["Linear", LINEAR_AGENT_ENV.secret],
    ["Slack", SLACK_ENV.secret],
    ["A2A", A2A_ENV.token],
    ["AG-UI", AGUI_ENV.on],
  ] as const;
  const bound = () => ({ repo: deps.repo, on: surfaces.flatMap(([name, k]) => (key(k) ? [name] : [])) });
  return { routes, secrets, bound };
}
