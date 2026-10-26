// One plane, two repos: every route that acts on a repo is told which one by the access gate, lists
// cover every served repo, and a write lands only in the repo it names. The walk drives every route,
// so a handler that reads a repo its route never declared fails here instead of acting on a guess.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDashboard, PUBLIC_ROUTES } from "../dashboard/server";
import type { GhIssue } from "../src/github";
import { defaultStatePath } from "../src/paths";
import { FactoryState } from "../src/state";
import { signatureOf, WEBHOOK_SECRET_ENV } from "../src/webhook";

const A = "acme/a";
const B = "acme/b";
const SECRET = "multi-repo-secret";
const saved = { home: process.env.FACTORY_HOME, repos: process.env.FACTORY_REPOS };
const home = mkdtempSync(join(tmpdir(), "factory-multi-"));
const states: Record<string, FactoryState> = {};

beforeAll(() => {
  process.env.FACTORY_HOME = home;
  process.env.FACTORY_REPOS = `${A},${B}`;
  for (const r of [A, B]) {
    const path = defaultStatePath(process.env, r);
    mkdirSync(dirname(path), { recursive: true });
    states[r] = new FactoryState(path);
    states[r].upsertRun({ issue: 1, repo: r, title: `run in ${r}`, stage: "plan", status: "running" });
  }
});
afterAll(() => {
  if (saved.home === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved.home;
  if (saved.repos === undefined) delete process.env.FACTORY_REPOS;
  else process.env.FACTORY_REPOS = saved.repos;
  rmSync(home, { recursive: true, force: true });
});

const issue = (repo: string): GhIssue => ({ number: 1, title: `issue in ${repo}`, body: "", labels: [], comments: [] });

// Anything the walk reaches that this fake does not answer fails as offline, never as a real `gh` call.
function fakeGitHub() {
  const created: { repo: string; title: string }[] = [];
  const known = {
    created,
    listOpenIssues: async (repo: string) => [issue(repo)],
    listIssuesByLabel: async () => [],
    listPrs: async () => [],
    getIssue: async (repo: string) => issue(repo),
    prForIssue: async () => undefined,
    commentIssue: async () => 1,
    createIssue: async (repo: string, title: string) => {
      created.push({ repo, title });
      return 7;
    },
  };
  return new Proxy(known, {
    get: (t, p) =>
      p in t
        ? t[p as keyof typeof t]
        : async () => {
            throw new Error(`offline: ${String(p)}`);
          },
  }) as typeof known;
}

function plane() {
  const github = fakeGitHub();
  const probes = { which: () => null, versionOf: async () => null };
  const dashboard = createDashboard(
    new FactoryState(":memory:"),
    github as never,
    "",
    false,
    join(home, "ws"),
    undefined,
    probes as never,
  );
  return { github, dashboard };
}

const BASE = "http://localhost:4100";
const sample = (label: string) => label.split(" ")[1]!.replace(":n", "1").replace(":id", "1");
function request(label: string, repo?: string, extra: Record<string, unknown> = {}) {
  const [method, path] = label.split(" ") as [string, string];
  const query = repo !== undefined && method === "GET" ? `?repo=${encodeURIComponent(repo)}` : "";
  return new Request(`${BASE}${sample(`${method} ${path}`)}${query}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify({ ...(repo !== undefined ? { repo } : {}), ...extra }) : undefined,
  });
}

// A stream or long poll never ends, so a route that is still answering after a second has passed the gate.
// The request is aborted after, or a stream's timer keeps reading a DB afterAll has deleted.
async function hit(dashboard: ReturnType<typeof plane>["dashboard"], req: Request) {
  const abort = new AbortController();
  const timeout = new Promise<"open">((r) => setTimeout(() => r("open"), 1000));
  try {
    const signed = new Request(req, { signal: abort.signal });
    const out = await Promise.race([dashboard.handle(signed, "127.0.0.1").catch((e: Error) => e), timeout]);
    if (out instanceof Response) {
      const text = await Promise.race([out.text(), timeout]);
      return { status: out.status, text: typeof text === "string" ? text : "" };
    }
    return { status: out === "open" ? 200 : 500, text: out === "open" ? "" : out.message };
  } finally {
    abort.abort();
  }
}

describe("one plane, many repos", () => {
  test("every route that names a repo declares where, and the gate refuses a missing, unknown or unserved one", async () => {
    const { dashboard } = plane();
    const scopes = dashboard.routeScopes as Record<string, "query" | "body" | "filter" | null>;
    expect(Object.values(scopes).filter(Boolean).length).toBeGreaterThan(20);
    for (const label of dashboard.routeLabels as string[]) {
      if (PUBLIC_ROUTES.includes(label) || label.startsWith("POST /webhook") || label.includes("/runner/")) continue;
      const scope = scopes[label];
      const named = await hit(dashboard, request(label, B));
      expect(named.text, label).not.toContain("declares no repo scope");
      if (!scope) continue;
      expect(named.text, label).not.toContain("unknown repo");
      expect(named.text, label).not.toContain("pick a repo");
      const unserved = await hit(dashboard, request(label, "acme/elsewhere"));
      expect([unserved.status, unserved.text.includes("unknown repo")], label).toEqual([404, true]);
      const malformed = await hit(dashboard, request(label, "../etc"));
      expect(malformed.status, label).toBe(400);
      const none = await hit(dashboard, request(label));
      if (scope === "filter") expect(none.text, label).not.toContain("pick a repo");
      else expect([none.status, none.text.includes("pick a repo")], label).toEqual([400, true]);
    }
  }, 120_000);

  test("a list covers every served repo, tagged, and a filter narrows it to one", async () => {
    const { dashboard } = plane();
    const runs = async (repo?: string) =>
      (
        (await (await dashboard.handle(request("GET /api/runs", repo), "127.0.0.1")).json()) as {
          runs: { repo: string; title: string }[];
        }
      ).runs
        .map((r) => `${r.repo}:${r.title}`)
        .sort();
    expect(await runs()).toEqual([`${A}:run in ${A}`, `${B}:run in ${B}`]);
    expect(await runs(B)).toEqual([`${B}:run in ${B}`]);
  });

  test("a write lands only in the repo it names", async () => {
    const { dashboard, github } = plane();
    const toggle = await dashboard.handle(
      request("POST /api/toggles", B, { key: "auto_start", value: false }),
      "127.0.0.1",
    );
    expect(toggle.status).toBe(200);
    expect(states[B]!.getToggle("auto_start", true)).toBe(false);
    expect(states[A]!.getToggle("auto_start", true)).toBe(true);
    expect((await dashboard.handle(request("POST /api/tasks", B, { title: "Fix the cart" }), "127.0.0.1")).status).toBe(
      200,
    );
    expect(github.created).toEqual([{ repo: B, title: "Fix the cart" }]);
  });

  test("with one served repo, a request that names none acts on it", async () => {
    process.env.FACTORY_REPOS = A;
    try {
      const { dashboard, github } = plane();
      expect((await dashboard.handle(request("POST /api/tasks", undefined, { title: "t" }), "127.0.0.1")).status).toBe(
        200,
      );
      expect(github.created).toEqual([{ repo: A, title: "t" }]);
    } finally {
      process.env.FACTORY_REPOS = `${A},${B}`;
    }
  });

  test("a webhook records in the repo it is for, and one for an unserved repo records nothing", async () => {
    process.env[WEBHOOK_SECRET_ENV] = SECRET;
    try {
      const { dashboard } = plane();
      const deliver = (id: string, repo: string) => {
        const raw = JSON.stringify({
          action: "labeled",
          repository: { full_name: repo },
          label: { name: "factory:ready" },
        });
        return dashboard.handle(
          new Request(`${BASE}/webhook/github`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-delivery": id,
              "x-github-event": "issues",
              "x-hub-signature-256": signatureOf(SECRET, raw),
            },
            body: raw,
          }),
          "203.0.113.7",
        );
      };
      expect((await deliver("d-b", "ACME/B")).status).toBe(201);
      expect((await deliver("d-x", "evil/fork")).status).toBe(202);
      expect([states[A]!.latestDelivery(), states[B]!.latestDelivery()]).toEqual([0, 1]);
    } finally {
      delete process.env[WEBHOOK_SECRET_ENV];
    }
  });
});

// One resolver: the repo a request names is parsed in one file, and the served list comes from one function.
describe("one repo resolver", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === "node_modules" || n === "public" || n === "tests") return [];
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const root = join(import.meta.dir, "..");
  const sources = ["src", "dashboard", "ee"].flatMap((d) => files(join(root, d)));
  const readers = (re: RegExp) =>
    sources.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));

  test("only dashboard/plane/repo-scope.ts reads a request's repo name", () => {
    expect(readers(/searchParams\.get\(["']repo["']\)|\{ repo\?: unknown \}/)).toEqual([
      "dashboard/plane/repo-scope.ts",
    ]);
  });

  test("only src/paths.ts reads FACTORY_REPOS, and nothing reads FACTORY_BLOB_REPOS", () => {
    expect(readers(/FACTORY_REPOS\b/)).toEqual(["src/paths.ts"]);
    expect(readers(/FACTORY_BLOB_REPOS/)).toEqual([]);
  });
});
