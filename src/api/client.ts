// A client whose methods come from ROUTES: `client.runs.list({repo})` calls the `runs.list` route.

import { coreRoutes } from "./core";
import { fixture, FIXTURE_TOKEN } from "./fixtures";
import { ROUTES } from "./routes";
import type { Run, RunEvent } from "../state";

export type Params = Record<string, string | number | undefined>;
type Spend = { since: string; repos: { repo: string; costUsd: number; unreportedRuns: number }[] };

export interface ApiClient {
  health(): Promise<{ ok: boolean }>;
  repos: { list(): Promise<{ repos: string[] }> };
  runs: {
    list(p?: { repo?: string }): Promise<{ runs: Run[] }>;
    get(p: { repo: string; issue: number }): Promise<{ run: Run }>;
    events(p: { repo: string; issue: number; after?: number }): Promise<{ events: RunEvent[] }>;
  };
  spend: { get(p?: { since?: string }): Promise<Spend> };
  /** The raw SSE response; pass `lastEventId` to resume. */
  stream(p?: { lastEventId?: number }): Promise<Response>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const root: Record<string, unknown> = {};
  for (const route of ROUTES) {
    const call = async (p: Params & { lastEventId?: number } = {}): Promise<unknown> => {
      const used = new Set<string>();
      const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
        used.add(name);
        if (p[name] === undefined) throw new Error(`${route.id}: missing "${name}"`);
        return encodeURIComponent(String(p[name]));
      });
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(p))
        if (!used.has(k) && k !== "lastEventId" && v !== undefined) query.set(k, String(v));
      const headers: Record<string, string> = {};
      if (route.auth === "token") headers.authorization = `Bearer ${token}`;
      if (route.sse && p.lastEventId !== undefined) headers["last-event-id"] = String(p.lastEventId);
      const qs = query.size ? `?${query}` : "";
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}${qs}`, { method: route.method, headers });
      if (route.sse) return res;
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
      return body;
    };
    const names = route.id.split(".");
    let node = root;
    for (const name of names.slice(0, -1)) node = (node[name] ??= {}) as Record<string, unknown>;
    node[names.at(-1)!] = call;
  }
  return root as unknown as ApiClient;
}

/** A client over an in-process core API on a named fixture; no socket. */
export function fakeClient(name: string): ApiClient {
  const api = coreRoutes(fixture(name));
  const inProcess = ((input: string | URL | Request, init?: RequestInit) =>
    api.fetch(new Request(input as string, init))) as typeof fetch;
  return createClient("http://fixture.invalid", FIXTURE_TOKEN, inProcess);
}
