// The core API: matches every ROUTES entry, gates token routes, and feeds the live stream.

import type { Run, RunEvent } from "../state";
import type { ApiAuth } from "./auth";
import { metricsFor, type MetricsState } from "../metrics-get";
import { type ApiRoute, ROUTES } from "./routes";
import { type LiveFeed, sseResponse } from "./stream";

/** The slice of FactoryState the API reads. */
export interface ApiState extends MetricsState {
  listRuns(repo?: string): Run[];
  getRun(repo: string, issue: number): Run | undefined;
  listEvents(runId: number, opts?: { after?: number; limit?: number }): RunEvent[];
  spendSummary(repo: string, sinceIso: string): { costUsd: number; unreportedRuns: number };
}

export interface CoreDeps {
  repos(): string[];
  state(repo: string): ApiState | null;
  feed: LiveFeed;
  auth: ApiAuth;
  /** Passes for callers who may see cost; without it metrics.get omits cost. */
  operator?: ApiAuth;
}

const SPEND_WINDOW_MS = 30 * 24 * 3600 * 1000;

function compile(route: ApiRoute): { route: ApiRoute; match(path: string): Record<string, string> | null } {
  const parts = route.path.split("/");
  return {
    route,
    match(path) {
      const got = path.split("/");
      if (got.length !== parts.length) return null;
      const params: Record<string, string> = {};
      for (const [i, part] of parts.entries()) {
        if (part.startsWith(":")) {
          try {
            params[part.slice(1)] = decodeURIComponent(got[i]!);
          } catch {
            return null;
          }
        } else if (part !== got[i]) return null;
      }
      return params;
    },
  };
}

const COMPILED = ROUTES.map(compile);
// The one reader of query parameters; each route declares its own in ROUTES.
const query = (url: URL, name: string) => url.searchParams.get(name);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const err = (status: number, error: string) => json({ error }, status);

export function coreRoutes(deps: CoreDeps): { fetch(req: Request): Promise<Response> } {
  async function handle(route: ApiRoute, params: Record<string, string>, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = (): { repo: string; state: ApiState } | Response => {
      const repo = params.repo!;
      const state = deps.repos().includes(repo) ? deps.state(repo) : null;
      return state ? { repo, state } : err(404, "no such repo");
    };
    const issueOf = (): number | null => (/^[1-9]\d*$/.test(params.issue ?? "") ? Number(params.issue) : null);
    switch (route.id) {
      case "health":
        return json({ ok: true });
      case "repos.list":
        return json({ repos: deps.repos() });
      case "runs.list": {
        const only = query(url, "repo");
        const repos = only ? deps.repos().filter((r) => r === only) : deps.repos();
        if (only && repos.length === 0) return err(404, "no such repo");
        return json({ runs: repos.flatMap((r) => deps.state(r)?.listRuns(r) ?? []) });
      }
      case "runs.get":
      case "runs.events": {
        const issue = issueOf();
        if (issue === null) return err(400, "issue must be a positive integer");
        const t = target();
        if (t instanceof Response) return t;
        const run = t.state.getRun(t.repo, issue);
        if (!run) return err(404, "no such run");
        if (route.id === "runs.get") return json({ run });
        const after = Number(query(url, "after") ?? 0);
        if (!Number.isInteger(after) || after < 0) return err(400, "after must be a non-negative integer");
        return json({ events: t.state.listEvents(run.id, { after }) });
      }
      case "spend.get": {
        const since = query(url, "since") ?? new Date(Date.now() - SPEND_WINDOW_MS).toISOString();
        if (Number.isNaN(Date.parse(since))) return err(400, "since must be an ISO date");
        const repos = deps.repos().flatMap((repo) => {
          const state = deps.state(repo);
          return state ? [{ repo, ...state.spendSummary(repo, since) }] : [];
        });
        return json({ since, repos });
      }
      case "metrics.get": {
        const sources = deps.repos().flatMap((repo) => {
          const state = deps.state(repo);
          return state ? [{ repo, state }] : [];
        });
        return json({ metrics: metricsFor(sources, { operator: deps.operator?.(req) === true }) });
      }
      case "stream": {
        const raw = req.headers.get("last-event-id");
        // A cursor that is not a number can never be in the ring, so it resets like a stale one.
        const last = raw ? (Number.isNaN(Number(raw)) ? -1 : Number(raw)) : undefined;
        return sseResponse(deps.feed, last, req.signal);
      }
      default:
        return err(404, "not found");
    }
  }

  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      for (const { route, match } of COMPILED) {
        const params = route.method === req.method ? match(path) : null;
        if (!params) continue;
        if (route.auth === "token" && !deps.auth(req) && !deps.operator?.(req)) return err(401, "unauthorized");
        return handle(route, params, req);
      }
      return err(404, "not found");
    },
  };
}

const ENDED = new Set(["shipped", "failed", "cancelled", "rejected"]);

type Snapshot = { stage: string; status: string; updated_at: string; lastEvent: number };

/**
 * Diffs the state every `everyMs` into feed pushes. The first pass only records what already exists.
 * Returns `tick` (one pass, for tests) and `stop`.
 */
export function startFeedPoller(
  deps: Pick<CoreDeps, "repos" | "state">,
  feed: LiveFeed,
  everyMs: number,
): { tick(): void; stop(): void } {
  const seen = new Map<string, Snapshot>();
  let primed = false;

  function tick(): void {
    for (const repo of deps.repos()) {
      const state = deps.state(repo);
      if (!state) continue;
      for (const run of state.listRuns(repo)) {
        const key = `${repo}#${run.issue}`;
        const prev = seen.get(key);
        const base = { repo, issue: run.issue };
        let lastEvent = prev?.lastEvent ?? 0;
        if (primed) {
          const changed =
            !prev || prev.updated_at !== run.updated_at || prev.stage !== run.stage || prev.status !== run.status;
          if (changed) {
            const moved = prev && prev.stage !== run.stage;
            const ended = prev && prev.status !== run.status && ENDED.has(run.status);
            if (moved) feed.push("stage.finished", { ...base, stage: prev.stage, status: prev.status });
            else if (ended) feed.push("stage.finished", { ...base, stage: run.stage, status: run.status });
            if (!prev || prev.stage !== run.stage) feed.push("stage.started", { ...base, stage: run.stage });
            feed.push("run.updated", { ...base, stage: run.stage, status: run.status, updated_at: run.updated_at });
          }
        }
        for (const e of state.listEvents(run.id, { after: lastEvent, limit: 1000 })) {
          lastEvent = e.id;
          if (primed)
            feed.push("log.appended", { ...base, id: e.id, ts: e.ts, stage: e.stage, kind: e.kind, text: e.text });
        }
        seen.set(key, { stage: run.stage, status: run.status, updated_at: run.updated_at, lastEvent });
      }
    }
    primed = true;
  }

  tick();
  const timer = setInterval(tick, everyMs);
  return { tick, stop: () => clearInterval(timer) };
}
