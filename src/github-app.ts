// A GitHub App gives each owner its own installation token, so one hosted plane serving many repos
// spends each owner's rate limit, not one login's for all of them. Tokens live in memory only: they
// reach `gh` through its env and are never logged or returned.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { type CommandResult, type CommandRunner, GhCommandRunner } from "./github";
import { feedServedRepos, isRepoName } from "./paths";
import type { RateBudget } from "./ports/scm";

export const APP_ENV = { id: "FACTORY_GITHUB_APP_ID", key: "FACTORY_GITHUB_APP_PRIVATE_KEY" } as const;
// GitHub mints a token for an hour; one reused into its last minutes can expire mid-run.
export const TOKEN_MARGIN_MS = 5 * 60_000;
export const INSTALLED_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// RS256 over header.payload. iat is 60s back because GitHub rejects a clock running ahead of its own.
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iat, exp: iat + 540, iss: appId }))}`;
  return `${head}.${b64u(sign("RSA-SHA256", Buffer.from(head), key))}`;
}

interface Minted {
  token: string;
  expiresAt: number;
}

export interface AppOptions {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  apiUrl?: string;
}

export class GitHubApp {
  private readonly key: KeyObject;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly api: string;
  private readonly tokens = new Map<string, Minted>();
  private readonly minting = new Map<string, Promise<string | null>>();
  private readonly installs = new Map<string, number | null>();

  constructor(private readonly opts: AppOptions) {
    // Checked at boot, and the error never echoes the key.
    try {
      this.key = createPrivateKey(opts.privateKey.replace(/\\n/g, "\n"));
    } catch {
      throw new Error(`${APP_ENV.key} is not a PEM private key`);
    }
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.api = opts.apiUrl ?? "https://api.github.com";
  }

  private async call(path: string, auth: string, method = "GET"): Promise<Response> {
    return this.doFetch(`${this.api}${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${auth}` },
    });
  }

  private async body<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw new Error(`GitHub App: ${what} answered ${res.status}`);
    return (await res.json()) as T;
  }

  private jwt = () => appJwt(this.opts.appId, this.key, this.now());

  // The installation token for a repo's owner, or null when the App is not installed there.
  async tokenFor(repo: string): Promise<string | null> {
    const owner = repo.split("/")[0]!.toLowerCase();
    const held = this.tokens.get(owner);
    if (held && this.now() < held.expiresAt - TOKEN_MARGIN_MS) return held.token;
    const pending = this.minting.get(owner);
    if (pending) return pending;
    const p = this.mint(owner, repo).finally(() => this.minting.delete(owner));
    this.minting.set(owner, p);
    return p;
  }

  private async mint(owner: string, repo: string, known?: number): Promise<string | null> {
    let id = known ?? this.installs.get(owner);
    if (id === undefined) {
      const res = await this.call(`/repos/${repo}/installation`, this.jwt());
      id = res.status === 404 ? null : (await this.body<{ id: number }>(res, "the installation lookup")).id;
      this.installs.set(owner, id);
    }
    if (id === null) return null;
    const res = await this.call(`/app/installations/${id}/access_tokens`, this.jwt(), "POST");
    const { token, expires_at } = await this.body<{ token: string; expires_at: string }>(res, "minting a token");
    this.tokens.set(owner, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  // Every repo any installation of the App can reach, for the plane's served list.
  async installedRepos(): Promise<string[]> {
    const repos: string[] = [];
    for (let page = 1; ; page++) {
      const res = await this.call(`/app/installations?per_page=100&page=${page}`, this.jwt());
      const list = await this.body<{ id: number; account: { login: string } }[]>(res, "listing installations");
      for (const inst of list) {
        const owner = inst.account.login.toLowerCase();
        this.installs.set(owner, inst.id);
        const held = this.tokens.get(owner);
        const token =
          held && this.now() < held.expiresAt - TOKEN_MARGIN_MS ? held.token : await this.mint(owner, "", inst.id);
        if (token) repos.push(...(await this.reposOf(token)));
      }
      if (list.length < 100) return [...new Set(repos)].sort();
    }
  }

  private async reposOf(token: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const res = await this.call(`/installation/repositories?per_page=100&page=${page}`, token);
      const { repositories } = await this.body<{ repositories: { full_name: string }[] }>(res, "listing repos");
      out.push(...repositories.map((r) => r.full_name).filter(isRepoName));
      if (repositories.length < 100) return out;
    }
  }
}

// The repo a gh call acts on: `--repo`, an api path under repos/, or graphql's owner and name vars.
export function repoOfArgs(args: readonly string[]): string {
  const i = args.indexOf("--repo");
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  if (args[0] !== "api") return "";
  for (const a of args) {
    const m = a.match(/^\/?repos\/([\w.-]+\/[\w.-]+)(?:\/|$)/);
    if (m) return m[1]!;
  }
  const v = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  const owner = v("owner");
  const name = v("name");
  return owner && name ? `${owner}/${name}` : "";
}

// Runs each gh call as the installation of the repo it names; a call naming no repo, or a repo
// the App is not installed on, keeps gh's own login as before.
export class AppTokenRunner implements CommandRunner {
  constructor(
    private readonly app: GitHubApp,
    private readonly inner: CommandRunner = new GhCommandRunner(),
  ) {}

  async run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CommandResult> {
    const repo = repoOfArgs(args);
    const token = repo ? await this.app.tokenFor(repo) : null;
    if (!token) return this.inner.run(args, opts);
    return this.inner.run(args, { ...opts, env: { ...opts?.env, GH_TOKEN: token } });
  }
}

// One App per process, so every ScmPort and the served list share one token cache.
let shared: { id: string; app: GitHubApp } | null = null;
export function appFromEnv(env: Record<string, string | undefined> = process.env): GitHubApp | null {
  const id = env[APP_ENV.id] ?? "";
  const key = env[APP_ENV.key] ?? "";
  if (!id && !key) return null;
  if (!id || !key) throw new Error(`${APP_ENV.id} and ${APP_ENV.key} are set together or not at all`);
  if (shared?.id !== id) shared = { id, app: new GitHubApp({ appId: id, privateKey: key }) };
  return shared.app;
}

export function ghRunner(env: Record<string, string | undefined> = process.env): CommandRunner {
  const app = appFromEnv(env);
  return app ? new AppTokenRunner(app) : new GhCommandRunner();
}

// The core budget of the token that serves this repo: its installation's, else gh's own login.
export async function rateBudget(
  repo: string,
  app: GitHubApp | null = appFromEnv(),
  inner: CommandRunner = new GhCommandRunner(),
): Promise<RateBudget> {
  const token = app ? await app.tokenFor(repo) : null;
  const args = ["api", "rate_limit", "--jq", ".resources.core | {remaining, limit}"];
  const out = await inner.run(args, token ? { env: { GH_TOKEN: token } } : undefined);
  if (out.code !== 0) throw new Error(`gh api rate_limit failed (${out.code})`);
  return JSON.parse(out.stdout) as RateBudget;
}

// The served list stays sync (src/paths.ts), so the App's repos are a cache refreshed in the
// background whenever a read finds it older than ttlMs.
export function feedInstalledRepos(app: GitHubApp, ttlMs = INSTALLED_TTL_MS, now: () => number = Date.now) {
  let repos: readonly string[] = [];
  let at = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  const refresh = () => {
    inflight ??= app
      .installedRepos()
      .then((r) => {
        repos = r;
        at = now();
      })
      .catch((e: Error) => console.error(`GitHub App: ${e.message}`))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  feedServedRepos(() => {
    if (now() - at > ttlMs) void refresh();
    return repos;
  });
  return { refresh };
}
