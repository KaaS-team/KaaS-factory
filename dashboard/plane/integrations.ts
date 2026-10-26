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
import { parseEvent } from "../../src/core/event";
import { WEBHOOK_MAX_BYTES } from "../../src/webhook";
import pkg from "../../package.json";
import type { Route } from "./access";
import type { PlaneStore } from "./store";

export const LINEAR_ROUTE = "POST /integrations/linear";
export const SLACK_ROUTE = "POST /integrations/slack";
export const A2A_CARD_ROUTE = "GET /.well-known/agent-card.json";
export const A2A_ROUTE = "POST /a2a";
// Reached by the vendor or the A2A client, never with a dashboard session; each checks its own caller.
export const INTEGRATION_PUBLIC_ROUTES = [LINEAR_ROUTE, SLACK_ROUTE, A2A_CARD_ROUTE, A2A_ROUTE] as const;

export type Secrets = Record<string, () => string>;

export interface IntegrationDeps {
  readonly state: Pick<FactoryState, "busEvents">;
  readonly tracker: SteerTracker;
  readonly repo: string;
  readonly project?: { readonly config: { readonly tracker: { readonly kind: string } } };
  // Plane members' roles; a Slack or Linear user steers only as the member its allowlist maps it to.
  readonly store: Pick<PlaneStore, "roleOf">;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly links?: () => LinkStore;
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });
const tooLarge = (req: Request) => Number(req.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES;
// The receivers ack first and finish here, so a slow tracker never makes a vendor retry.
const defer = (work: Promise<void>) =>
  void work.catch((e) => console.error(`integration: ${e instanceof Error ? e.message : String(e)}`));

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
      handler: (req) => {
        const secret = key(LINEAR_AGENT_ENV.secret);
        if (!secret) return notFound();
        if (tooLarge(req)) return Response.json({ error: "too large" }, { status: 413 });
        const client = new LinearAgentClient(env.LINEAR_AGENT_URL, env);
        const sameBoard = deps.project?.config.tracker.kind === "linear";
        return linearAgentReceiver({
          secret,
          repo: deps.repo,
          tracker: deps.tracker,
          links: links(),
          client,
          sameBoard,
          actor: surfaceActors(env[LINEAR_AGENT_ENV.users], (login) => deps.store.roleOf(login)),
          defer,
        })(req);
      },
    },
    {
      method: "POST",
      pattern: /^\/integrations\/slack$/,
      label: SLACK_ROUTE,
      handler: (req) => {
        const secret = key(SLACK_ENV.secret);
        if (!secret) return notFound();
        if (tooLarge(req)) return Response.json({ error: "too large" }, { status: 413 });
        const client = new SlackClient(env.SLACK_API_URL, env);
        const actor = surfaceActors(env[SLACK_ENV.users], (login) => deps.store.roleOf(login));
        return slackReceiver({ secret, repo: deps.repo, tracker: deps.tracker, links: links(), client, actor, defer })(
          req,
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
      handler: (req) => {
        if (!key(A2A_ENV.token)) return notFound();
        if (tooLarge(req)) return Response.json({ error: "too large" }, { status: 413 });
        return a2aRpc({ token: key(A2A_ENV.token), repo: deps.repo, tracker: deps.tracker, links: links() }, req);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/agui\/(\d+)$/,
      label: "GET /api/agui/:n",
      role: "viewer",
      handler: (_req, _url, m) => {
        if (!key(AGUI_ENV.on)) return notFound();
        const events = deps.state.busEvents(500).flatMap((row) => {
          const { subject, ...rest } = row;
          const parsed = parseEvent({
            ...rest,
            ...(subject ? { subject } : {}),
            specversion: "1.0",
            data: JSON.parse(row.data),
          });
          return parsed.ok ? [parsed.event] : [];
        });
        return new Response(sse(aguiEvents(events, deps.repo, Number(m[1]))), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      },
    },
  ];
  return { routes, secrets };
}
