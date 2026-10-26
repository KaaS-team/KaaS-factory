// Where a route reads the repo it acts on, checked once before any handler or extension sees it,
// so a handler, the tenancy check and the audit row can never disagree about the target.
import { isRepoName } from "../../src/paths";
import type { RepoRole } from "../../src/ports/scm";
import type { FactoryState } from "../../src/state";
import type { PlaneExtension } from "./extension";

// query: `?repo=`; body: the JSON body's `repo`; filter: an optional `?repo=` that narrows a list.
export type RepoSource = "query" | "body" | "filter";

export interface RepoScope {
  // Every repo this plane serves, in the order lists show them.
  served(): string[];
}

const refuse = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

// The name a request gives, "" when it gives none, or a 400 for one that names two repos or a non-string.
async function named(req: Request): Promise<string | Response> {
  const q = new URL(req.url).searchParams.get("repo") ?? "";
  let b: unknown;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = (await req
      .clone()
      .json()
      .catch(() => null)) as { repo?: unknown } | null;
    b = body && typeof body === "object" ? body.repo : undefined;
  }
  if (b !== undefined && b !== null && typeof b !== "string") return refuse("repo must be a string", 400);
  const body = typeof b === "string" ? b : "";
  if (q && body && q !== body) return refuse("?repo= and the body name different repos", 400);
  return q || body;
}

// The repo the request acts on ("" for an unfiltered list), or the refusal to send instead.
// An unserved repo and one the caller may not see get the same 404, so a name cannot be probed.
export async function resolveRepo(
  req: Request,
  source: RepoSource,
  scope: RepoScope,
  visible: (repos: readonly string[]) => string[],
): Promise<string | Response> {
  const given = await named(req);
  if (given instanceof Response) return given;
  if (given && !isRepoName(given)) return refuse("repo must be owner/name", 400);
  const served = scope.served();
  let repo = given;
  if (!repo && source === "filter") return "";
  // The default repo is not a fallback here: with two served, a write that names none could land in either.
  if (!repo) repo = served.length === 1 ? served[0]! : "";
  if (!repo) return refuse("pick a repo: this plane serves more than one", 400);
  if (!served.includes(repo) || visible([repo]).length === 0) return refuse("unknown repo", 404);
  return repo;
}

// Run ids are per DB, and the shared pre-v2.6.2 DB holds many repos, so a run must be the named repo's.
export function runIn(st: FactoryState | null, repo: string, id: number) {
  const run = st?.listRuns(repo).find((r) => r.id === id);
  return st && run ? { st, run } : null;
}

export const READ_TTL_MS = 10 * 60_000;

// A hosted plane shows a signed-in member only the repos GitHub lets them read; plane roles still
// decide what they may do there. Logins starting with ~ (break-glass, loopback, relay) are not
// GitHub accounts, so they keep every repo. An unanswered lookup hides the repo until it answers.
export function readAccess(
  roleOf: (repo: string, login: string) => Promise<RepoRole>,
  now: () => number = Date.now,
): PlaneExtension {
  const seen = new Map<string, { at: number; read: boolean }>();
  const key = (login: string, repo: string) => `${login}\n${repo}`;
  const fresh = (login: string, repo: string) => now() - (seen.get(key(login, repo))?.at ?? -Infinity) < READ_TTL_MS;
  return {
    name: "github-read",
    prepare: async (who, repos) => {
      if (who.login.startsWith("~")) return;
      const stale = repos.filter((r) => !fresh(who.login, r));
      await Promise.all(
        stale.map(async (r) => {
          const role = await roleOf(r, who.login).catch(() => null);
          if (role !== null) seen.set(key(who.login, r), { at: now(), read: role !== "none" });
        }),
      );
    },
    visibleRepos: (who, repos) =>
      who.login.startsWith("~")
        ? [...repos]
        : repos.filter((r) => fresh(who.login, r) && seen.get(key(who.login, r))!.read),
  };
}
