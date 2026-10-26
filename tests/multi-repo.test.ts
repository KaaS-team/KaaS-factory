// One plane, two repos: every route that acts on a repo is told which one by the access gate, lists
// cover every served repo, and a write lands only in the repo it names. The walk drives every route,
// so a handler that reads a repo its route never declared fails here instead of acting on a guess.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DashboardProject, projectResolver, READ_ONLY } from "../dashboard/project";
import { createAccess } from "../dashboard/plane/access";
import { readAccess } from "../dashboard/plane/repo-scope";
import { PlaneStore } from "../dashboard/plane/store";
import { createDashboard, PUBLIC_ROUTES } from "../dashboard/server";
import { DiskBlobStore } from "../src/adapters/blob-disk/blob";
import { mirrorDown } from "../src/blobs";
import { mergeConfig } from "../src/config";
import { shipConfig } from "../src/engine/blobs";
import type { GhIssue } from "../src/github";
import { configMirrorDir, defaultStatePath } from "../src/paths";
import { cloneDirFor } from "../src/repo";
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
  const listed: string[] = [];
  const known = {
    created,
    listed,
    listOpenIssues: async (repo: string) => {
      listed.push(repo);
      return [issue(repo)];
    },
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

function plane(shared = new FactoryState(":memory:")) {
  const github = fakeGitHub();
  const probes = { which: () => null, versionOf: async () => null };
  const dashboard = createDashboard(shared, github as never, "", false, join(home, "ws"), undefined, probes as never);
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

  test("a runner command acts on the job in the repo it names, never the same number in another", async () => {
    const { dashboard } = plane();
    const hub = dashboard.remote.hub;
    const box = hub.register(hub.issueToken(), "a-box")!;
    hub.heartbeat(box.id, [A]);
    const post = (path: string, repo: string) => dashboard.handle(request(`POST ${path}`, repo), "127.0.0.1");
    expect((await post("/api/issues/1/dispatch", A)).status).toBe(200);
    expect((await post("/api/issues/1/dispatch", B)).status).toBe(200);
    expect(hub.holder({ repo: A, issue: 1 })).toBe(box.id);
    expect(hub.holder({ repo: B, issue: 1 })).toBeNull();
    expect((await post("/api/issues/1/stop", B)).status).toBe(409);
    expect((await post("/api/issues/1/stop", A)).status).toBe(200);
    expect(hub.events(box.id, 0).map((e) => [e.type, JSON.parse(e.data).repo])).toEqual([
      ["lease", A],
      ["cancel", A],
    ]);
  });

  test("a runner holds only the served repos it declares", async () => {
    const { dashboard } = plane();
    const hub = dashboard.remote.hub;
    const box = hub.register(hub.issueToken(), "a-box")!;
    const beat = new Request(`${BASE}/runner/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${box.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "heartbeat", repos: [A, "acme/elsewhere", 7] }),
    });
    expect((await dashboard.handle(beat, "127.0.0.1")).status).toBe(200);
    expect(hub.reposOf(box.id)).toEqual([A]);
  });

  test("a run's events answer only under the repo the run is in, even from the shared pre-v2.6.2 DB", async () => {
    const shared = new FactoryState(":memory:");
    const other = shared.upsertRun({ issue: 9, repo: "acme/x", title: "not yours", stage: "plan", status: "running" });
    shared.appendEvent(other.id, "plan", "log", "a secret plan");
    process.env.FACTORY_REPOS = `${A},${B},acme/c`;
    try {
      const { dashboard } = plane(shared);
      // acme/c never ran here, so its reads fall back to the shared DB that holds acme/x's run.
      const res = await dashboard.handle(request(`GET /api/runs/${other.id}/events`, "acme/c"), "127.0.0.1");
      expect([res.status, await res.text()]).toEqual([404, JSON.stringify({ error: "no such run" })]);
    } finally {
      process.env.FACTORY_REPOS = `${A},${B}`;
    }
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

// A clone-shaped .factory/ whose workflow, minion, runtime ref and stage agent all carry the repo's tag.
const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"),
  "utf8",
);
function cloneOf(repo: string, tag: string, extra: Record<string, unknown>, dir = mkdtempSync(join(home, "clone-"))) {
  for (const d of ["workflows", "minions"]) mkdirSync(join(dir, ".factory", d), { recursive: true });
  writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ repo, base: "main", ...extra }));
  writeFileSync(
    join(dir, ".factory", "workflows", `${tag}-flow.yml`),
    WORKFLOW.replace("name: feature-to-pr", `name: ${tag}-flow`),
  );
  writeFileSync(
    join(dir, ".factory", "minions", `${tag}-min.yml`),
    `name: ${tag}-min\ndescription: d\non:\n  event: tasks.task.updated\nprompt: p\n`,
  );
  return dir;
}

describe("each repo's own config", () => {
  test("?repo=B shows the settings, workflows and minions B's runner shipped, never A's, and B is read only", async () => {
    const cloneA = cloneOf(A, "a", { runtime: { check: "local" } });
    const project: DashboardProject = {
      cloneDir: cloneA,
      config: mergeConfig({ repo: A, runtime: { check: "local" } }),
      machine: { slots: 1, runtimes: {} } as never,
      leases: async () => [],
    };
    const store = new DiskBlobStore(mkdtempSync(join(home, "store-")));
    expect(
      await shipConfig(
        store,
        cloneOf(B, "b", {
          runtime: { gates: "local" },
          stages: { default: "codex" },
          agents: { codex: { preset: "codex" } },
        }),
        B,
      ),
    ).toBe(3);
    expect(await mirrorDown(store, process.env, [B])).toBe(3);
    const asked: string[] = [];
    const probes = { which: (b: string) => (asked.push(b), null), versionOf: async () => null };
    const dash = createDashboard(
      states[A]!,
      fakeGitHub() as never,
      A,
      false,
      join(home, "ws"),
      undefined,
      probes as never,
      project,
    );
    const get = async (path: string, repo: string) =>
      (await hit(dash, new Request(`${BASE}${path}${path.includes("?") ? "&" : "?"}repo=${repo}`))).text;
    const view = async (repo: string) => ({
      workflows: (JSON.parse(await get("/api/workflows", repo)).workflows as { name: string }[]).map((w) => w.name),
      minions: (JSON.parse(await get("/api/minions", repo)).minions as { name: string }[]).map((m) => m.name),
      usedBy: (JSON.parse(await get("/api/settings", repo)).runtimes as { name: string; usedBy: string[] }[])
        .find((r) => r.name === "local")!
        .usedBy.filter((w) => w.startsWith("runtime.")),
      leasesError: JSON.parse(await get("/api/settings", repo)).leasesError as string | null,
      codex: (JSON.parse(await get("/api/agents", repo)).agents as { name: string; stages: string[] }[]).find(
        (a) => a.name === "codex",
      )?.stages.length,
    });
    expect(await view(A)).toMatchObject({
      workflows: expect.arrayContaining(["a-flow"]),
      minions: ["a-min"],
      usedBy: ["runtime.check"],
      leasesError: null,
      codex: 0,
    });
    expect(asked.length).toBeGreaterThan(0);
    asked.length = 0;
    const b = await view(B);
    // B's config came through the bucket, so the plane runs none of the binaries it names.
    expect(asked).toEqual([]);
    expect(b.workflows).not.toContain("a-flow");
    expect(b).toMatchObject({
      workflows: expect.arrayContaining(["b-flow"]),
      minions: ["b-min"],
      usedBy: ["runtime.gates"],
      leasesError: "leases are listed on the repo's runner, not this plane",
      codex: 6,
    });
    expect(JSON.parse(await get("/api/workflow-source?name=b-flow", B)).text).toContain("name: b-flow");
    expect(JSON.parse(await get("/api/workflow-source?name=a-flow", B)).available).toBe(false);
    expect(JSON.parse(await get("/api/workflow-source?name=..%2Fconfig", B)).available).toBe(false);
    expect((await hit(dash, new Request(`${BASE}/api/settings?repo=acme/elsewhere`))).status).toBe(404);
    for (const label of ["POST /api/workflow-edit", "POST /api/events/e1/replay"]) {
      const res = await hit(dash, request(label, B, { name: "b-flow", form: { build: { timeout: 5 } } }));
      expect([res.status, JSON.parse(res.text).error]).toEqual([409, READ_ONLY]);
    }
  });

  test("the plane's own clone of a repo wins over the shipped copy, and a config naming another repo is refused", async () => {
    const r = "acme/cloned";
    cloneOf(r, "own", {}, cloneDirFor(r, process.env));
    cloneOf(r, "shipped", {}, configMirrorDir(r, process.env));
    const resolve = projectResolver(A);
    const own = await resolve(r);
    expect([own?.cloneDir, own?.readOnly]).toEqual([cloneDirFor(r, process.env), undefined]);
    cloneOf(A, "planted", {}, configMirrorDir("acme/planted", process.env));
    expect(await resolve("acme/planted")).toBeUndefined();
    expect((await resolve("acme/nothing")) ?? "none").toBe("none");
  });
});

// A hosted plane: alice is a member, and GitHub says she can read A but not B.
function hostedPlane() {
  const github = fakeGitHub();
  const store = new PlaneStore();
  store.setMember("alice", "owner", "test");
  store.openSession("alice-session", "alice", 60_000);
  const filter = readAccess(async (r) => (r === B ? "none" : "read"));
  const access = createAccess({ token: "", store, extensions: [filter] });
  const probes = { which: () => null, versionOf: async () => null };
  const st = new FactoryState(":memory:");
  const ws = join(home, "ws");
  const dashboard = createDashboard(st, github as never, "", false, ws, undefined, probes as never, undefined, access);
  const as = (req: Request) => {
    const h = new Headers(req.headers);
    h.set("cookie", "factory_session=alice-session");
    return new Request(req, { headers: h });
  };
  return { dashboard, as };
}

describe("a hosted plane shows a member only the repos GitHub lets them read", () => {
  test("B is in no list, and every route that names B answers 404 for it", async () => {
    const { dashboard, as } = hostedPlane();
    const scopes = dashboard.routeScopes as Record<string, "query" | "body" | "filter" | null>;
    let lists = 0;
    for (const label of dashboard.routeLabels as string[]) {
      if (PUBLIC_ROUTES.includes(label) || label.startsWith("POST /webhook") || label.includes("/runner/")) continue;
      const scope = scopes[label];
      if (label.startsWith("GET ") && scope !== "query" && scope !== "body") {
        const all = await hit(dashboard, as(request(label)));
        expect(all.text, label).not.toContain(B);
        lists++;
      }
      if (!scope) continue;
      const named = await hit(dashboard, as(request(label, B)));
      expect([named.status, named.text.includes("unknown repo")], label).toEqual([404, true]);
      const readable = await hit(dashboard, as(request(label, A)));
      expect(readable.text, label).not.toContain("unknown repo");
    }
    expect(lists).toBeGreaterThan(10);
    const inbox = (await (await dashboard.handle(as(request("GET /api/inbox")), "127.0.0.1")).json()) as {
      repos: string[];
    };
    expect(inbox.repos).toEqual([A]);
  }, 120_000);

  test("break-glass and loopback still see every repo", async () => {
    const { dashboard } = hostedPlane();
    const res = await dashboard.handle(request("GET /api/runs"), "127.0.0.1");
    const runs = ((await res.json()) as { runs: { repo: string }[] }).runs.map((r) => r.repo).sort();
    expect(runs).toEqual([A, B]);
  });
});

describe("the board's gh budget on a plane", () => {
  test("a webhook for B reads B's issues again and leaves A's cached", async () => {
    process.env[WEBHOOK_SECRET_ENV] = SECRET;
    try {
      const { dashboard, github } = plane();
      const board = (r: string) => dashboard.handle(request("GET /api/board", r), "127.0.0.1");
      await board(A);
      await board(B);
      await board(A);
      await board(B);
      expect(github.listed).toEqual([A, B]);
      const raw = JSON.stringify({ action: "labeled", repository: { full_name: B }, label: { name: "x" } });
      const hook = new Request(`${BASE}/webhook/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "d-cache",
          "x-github-event": "issues",
          "x-hub-signature-256": signatureOf(SECRET, raw),
        },
        body: raw,
      });
      expect((await dashboard.handle(hook, "127.0.0.1")).status).toBeLessThan(300);
      await board(A);
      await board(B);
      expect(github.listed).toEqual([A, B, B]);
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
