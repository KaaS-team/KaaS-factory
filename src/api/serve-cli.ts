// `factory serve [--port N] [--fixture two-repos] [--print-url]`: the core API over HTTP on loopback.

import { existsSync } from "node:fs";
import type { CliContext } from "../cli-runtime";
import { defaultRepo, defaultStatePath, servedRepos } from "../paths";
import { FactoryState } from "../state";
import { tokenAuth } from "./auth";
import { coreRoutes, startFeedPoller, type CoreDeps } from "./core";
import { fixture } from "./fixtures";
import { LiveFeed } from "./stream";

export const DEFAULT_PORT = 4200;
const POLL_MS = 2000;

function liveDeps(): CoreDeps {
  const states = new Map<string, FactoryState>();
  const repos = () =>
    servedRepos(process.env, defaultRepo()).filter((r) => existsSync(defaultStatePath(process.env, r)));
  return {
    repos,
    state: (repo) => {
      if (!states.has(repo)) states.set(repo, new FactoryState(defaultStatePath(process.env, repo)));
      return states.get(repo)!;
    },
    feed: new LiveFeed(),
    auth: tokenAuth(process.env),
    operator: tokenAuth({ FACTORY_API_TOKEN: process.env.FACTORY_API_OPERATOR_TOKEN }),
  };
}

export async function cmdServe(cli: CliContext): Promise<ReturnType<typeof Bun.serve>> {
  const port = Number(cli.flag("port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("serve: --port must be 0-65535");
  const name = cli.flag("fixture");
  const deps = name ? fixture(name, process.env.FACTORY_API_TOKEN || undefined) : liveDeps();
  if (!name) startFeedPoller(deps, deps.feed, POLL_MS);
  if (!process.env.FACTORY_API_TOKEN && !name)
    console.error("factory serve: FACTORY_API_TOKEN is not set, so every route except /api/health answers 401");
  const api = coreRoutes(deps);
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (req) => api.fetch(req) });
  const url = `http://127.0.0.1:${server.port}`;
  if (cli.has("print-url")) console.log(url);
  else console.error(`factory serve: listening on ${url}`);
  return server;
}
