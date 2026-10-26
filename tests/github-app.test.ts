// A fake GitHub App behind an injected fetch, signed with a throwaway key: one installation token per
// owner, minted again before it expires, never printed; its repos join the served list; and the
// board's gh budget stretches for hooked repos and for a token near its limit.

import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { boardCache, HOOKED_MS, POLL_MS } from "../dashboard/plane/board-cache";
import { READ_TTL_MS, readAccess } from "../dashboard/plane/repo-scope";
import {
  AppTokenRunner,
  appFromEnv,
  feedInstalledRepos,
  GitHubApp,
  rateBudget,
  repoOfArgs,
  TOKEN_MARGIN_MS,
} from "../src/github-app";
import { feedServedRepos, servedRepos } from "../src/paths";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = createPublicKey(privateKey);
const HOUR = 60 * 60_000;

// Installations by owner, each with its repos; every call is recorded, and each mint is a new token.
function fakeGitHub(clock: { t: number }) {
  const installs: Record<string, { id: number; repos: string[] }> = {
    acme: { id: 1, repos: ["acme/a", "acme/b"] },
    beta: { id: 2, repos: ["beta/x"] },
  };
  const calls: string[] = [];
  const minted: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization).slice(7);
    const path = url.pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("/app")) {
      const [h, p, sig] = auth.split(".");
      if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), PUBLIC, Buffer.from(sig!, "base64url")))
        return reply({}, 401);
      expect(JSON.parse(Buffer.from(p!, "base64url").toString()).iss).toBe("42");
    }
    const repoInstall = path.match(/^\/repos\/([^/]+)\/[^/]+\/installation$/);
    if (repoInstall) {
      const i = installs[repoInstall[1]!];
      return i ? reply({ id: i.id }) : reply({}, 404);
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) {
      const token = `ghs_secret_${mint[1]}_${minted.length}`;
      minted.push(token);
      return reply({ token, expires_at: new Date(clock.t + HOUR).toISOString() }, 201);
    }
    if (path === "/app/installations")
      return reply(Object.entries(installs).map(([login, i]) => ({ id: i.id, account: { login } })));
    if (path === "/installation/repositories") {
      const i = Object.values(installs).find((x) => minted.some((m) => m === auth && m.includes(`_${x.id}_`)));
      return i ? reply({ repositories: i.repos.map((full_name) => ({ full_name })) }) : reply({}, 401);
    }
    return reply({}, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, minted };
}

function app() {
  const clock = { t: Date.parse("2026-10-26T10:00:00Z") };
  const gh = fakeGitHub(clock);
  return { clock, gh, app: new GitHubApp({ appId: "42", privateKey: PEM, fetch: gh.fetch, now: () => clock.t }) };
}

// What gh would have been spawned with, without spawning it.
function recorder() {
  const runs: { args: string[]; token?: string }[] = [];
  return {
    runs,
    run: async (args: string[], opts?: { env?: Record<string, string> }) => {
      runs.push({ args, token: opts?.env?.GH_TOKEN });
      return { stdout: '{"remaining":4000,"limit":5000}', stderr: "", code: 0 };
    },
  };
}

afterEach(() => feedServedRepos(null));

describe("GitHub App installation tokens", () => {
  test("one token per owner, shared by its repos, and minted again 5 minutes before it expires", async () => {
    const { clock, gh, app: a } = app();
    const inner = recorder();
    const runner = new AppTokenRunner(a, inner);
    await runner.run(["issue", "list", "--repo", "acme/a"]);
    await runner.run(["api", "repos/acme/b/collaborators/bob/permission"]);
    await runner.run(["api", "graphql", "-f", "query=q", "-F", "owner=beta", "-F", "name=x"]);
    await runner.run(["api", "user"]);
    expect(inner.runs.map((r) => r.token)).toEqual([gh.minted[0], gh.minted[0], gh.minted[1], undefined]);
    expect(gh.minted.length).toBe(2);
    clock.t += HOUR - TOKEN_MARGIN_MS - 1000;
    await runner.run(["issue", "list", "--repo", "acme/a"]);
    expect(gh.minted.length).toBe(2);
    clock.t += 2000;
    await runner.run(["issue", "list", "--repo", "acme/a"]);
    expect(gh.minted.length).toBe(3);
    expect(inner.runs.at(-1)!.token).toBe(gh.minted[2]);
  });

  test("a repo the App is not installed on keeps gh's own login", async () => {
    const { app: a } = app();
    const inner = recorder();
    await new AppTokenRunner(a, inner).run(["pr", "list", "--repo", "elsewhere/z"]);
    expect(inner.runs[0]!.token).toBeUndefined();
  });

  test("no token is ever printed, even when a call fails", async () => {
    const { gh, app: a } = app();
    const printed: string[] = [];
    const saved = { log: console.log, error: console.error, warn: console.warn };
    const grab = (...xs: unknown[]) => void printed.push(xs.map(String).join(" "));
    Object.assign(console, { log: grab, error: grab, warn: grab });
    try {
      await new AppTokenRunner(a, recorder()).run(["issue", "list", "--repo", "acme/a"]);
      const broken = new GitHubApp({
        appId: "42",
        privateKey: PEM,
        fetch: (async () => new Response(JSON.stringify({ token: gh.minted[0] }), { status: 500 })) as never,
      });
      const err = await broken.tokenFor("acme/a").catch((e: Error) => e.message);
      printed.push(String(err));
      await feedInstalledRepos(broken).refresh();
    } finally {
      Object.assign(console, saved);
    }
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) expect(line).not.toContain("ghs_secret");
  });

  test("the rate check reads the installation's own budget, else gh's login", async () => {
    const { gh, app: a } = app();
    const inner = recorder();
    expect(await rateBudget("acme/a", a, inner)).toEqual({ remaining: 4000, limit: 5000 });
    await rateBudget("acme/a", null, inner);
    expect(inner.runs.map((r) => r.token)).toEqual([gh.minted[0], undefined]);
  });

  test("an App id without its key refuses to start, and a bad key names the variable, not the key", () => {
    expect(() => appFromEnv({ FACTORY_GITHUB_APP_ID: "42" })).toThrow(
      "FACTORY_GITHUB_APP_ID and FACTORY_GITHUB_APP_PRIVATE_KEY are set together",
    );
    expect(appFromEnv({})).toBeNull();
    expect(() => new GitHubApp({ appId: "42", privateKey: "not-a-key" })).toThrow(
      "FACTORY_GITHUB_APP_PRIVATE_KEY is not a PEM private key",
    );
  });

  test("the repo of a gh call comes from --repo, an api path, or graphql's owner and name", () => {
    expect(repoOfArgs(["pr", "view", "1", "--repo", "a/b"])).toBe("a/b");
    expect(repoOfArgs(["api", "-X", "PATCH", "repos/a/b/issues/comments/1"])).toBe("a/b");
    expect(repoOfArgs(["api", "graphql", "-F", "owner=a", "-F", "name=b"])).toBe("a/b");
    expect(repoOfArgs(["api", "user"])).toBe("");
  });
});

describe("the App's repos in the served list", () => {
  test("every repo an installation reaches joins servedRepos, beside FACTORY_REPOS", async () => {
    const { app: a } = app();
    const env = { FACTORY_REPOS: "own/one", FACTORY_HOME: "/nonexistent" };
    expect(servedRepos(env)).toEqual(["own/one"]);
    await feedInstalledRepos(a).refresh();
    expect(servedRepos(env)).toEqual(["own/one", "acme/a", "acme/b", "beta/x"]);
  });

  test("the list is read again only once it is older than its TTL", async () => {
    const { gh, app: a } = app();
    let t = 0;
    const feed = feedInstalledRepos(a, 1000, () => t);
    await feed.refresh();
    const listings = () => gh.calls.filter((c) => c === "GET /app/installations").length;
    servedRepos({ FACTORY_REPOS: "own/one" });
    expect(listings()).toBe(1);
    t = 2000;
    servedRepos({ FACTORY_REPOS: "own/one" });
    await feed.refresh();
    expect(listings()).toBe(2);
  });
});

describe("the board's gh budget", () => {
  test("10s by default, 120s once a webhook arrives for that repo, doubled under 10% remaining", async () => {
    let t = 0;
    let budget = { remaining: 4000, limit: 5000 };
    let reads = 0;
    const cache = boardCache({
      now: () => t,
      rate: async () => {
        reads++;
        return budget;
      },
    });
    expect(await cache.ttl("acme/a")).toBe(POLL_MS);
    cache.heard("acme/a");
    expect([await cache.ttl("acme/a"), await cache.ttl("acme/b")]).toEqual([HOOKED_MS, POLL_MS]);
    budget = { remaining: 400, limit: 5000 };
    expect(await cache.ttl("acme/a")).toBe(HOOKED_MS);
    expect(reads).toBe(1);
    t += 60_000;
    expect([await cache.ttl("acme/a"), await cache.ttl("acme/b")]).toEqual([HOOKED_MS * 2, POLL_MS * 2]);
    expect(reads).toBe(2);
  });

  test("a webhook clears only its own repo's lists", async () => {
    const loads: string[] = [];
    const cache = boardCache({ now: () => 0 });
    const read = (r: string) => cache.read("issues", r, async () => void loads.push(r));
    await Promise.all([read("acme/a"), read("acme/b")]);
    cache.heard("acme/b");
    await Promise.all([read("acme/a"), read("acme/b")]);
    expect(loads).toEqual(["acme/a", "acme/b", "acme/b"]);
  });
});

describe("read access on GitHub", () => {
  test("a member sees only repos they can read, cached 10 minutes; ~ logins see everything", async () => {
    let t = 0;
    const asked: string[] = [];
    const ext = readAccess(
      async (repo, login) => {
        asked.push(`${login}:${repo}`);
        return repo === "acme/b" ? "none" : "read";
      },
      () => t,
    );
    const alice = { login: "alice", role: "owner" as const };
    await ext.prepare!(alice, ["acme/a", "acme/b"]);
    expect(ext.visibleRepos!(alice, ["acme/a", "acme/b"])).toEqual(["acme/a"]);
    await ext.prepare!(alice, ["acme/a", "acme/b"]);
    expect(asked.length).toBe(2);
    t += READ_TTL_MS;
    expect(ext.visibleRepos!(alice, ["acme/a", "acme/b"])).toEqual([]);
    await ext.prepare!(alice, ["acme/a", "acme/b"]);
    expect(asked.length).toBe(4);
    const glass = { login: "~break-glass", role: "owner" as const };
    await ext.prepare!(glass, ["acme/a", "acme/b"]);
    expect(ext.visibleRepos!(glass, ["acme/a", "acme/b"])).toEqual(["acme/a", "acme/b"]);
    expect(asked.length).toBe(4);
  });
});
