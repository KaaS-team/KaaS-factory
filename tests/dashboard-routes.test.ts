// Structural: every dashboard route sits in one table, and with a token set
// each one is refused without credentials unless it is on the public
// allow-list. A new route cannot ship open by accident. Also covers the new
// read and write routes (inbox, analytics, stages, artifacts).

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, type GhIssue, type GhPr, type MergeReadiness, type PrStatus } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState, type StageRunInput } from "../src/state";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config";
import type { DashboardProject } from "../dashboard/project";

class FakeGitHub extends GitHub {
  posted: { issue: number; body: string }[] = [];
  merged: { repo: string; prNumber: number; headSha: string }[] = [];
  constructor(private readonly issues: GhIssue[] = []) {
    super();
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return this.issues;
  }
  // GET /api/mode reads the control issue; none here.
  override async listIssuesByLabel() {
    return [];
  }
  // The inbox route also merges in learning-PR items (v2.10.0 item 4); no
  // fixture here opens one, so an empty list is the right default.
  override async listPrs(): Promise<GhPr[]> {
    return [];
  }
  override async getIssue(_repo: string, number: number): Promise<GhIssue> {
    return this.issues.find((i) => i.number === number)!;
  }
  override async commentIssue(_repo: string, issue: number, body: string): Promise<number | undefined> {
    this.posted.push({ issue, body });
    return 1;
  }
  // The review/merge routes (v2.9.0) look up the PR that closes an issue, its
  // diff and CI status, and its merge readiness. One fake PR per known issue
  // is enough for the route-walk and inbox tests, which never depend on its shape.
  override async prForIssue(_repo: string, issueNumber: number): Promise<GhPr | undefined> {
    if (!this.issues.some((i) => i.number === issueNumber)) return undefined;
    return {
      number: 100 + issueNumber,
      url: `https://github.com/acme/widgets/pull/${100 + issueNumber}`,
      state: "open",
      headRefName: `issue-${issueNumber}`,
      isDraft: false,
      closingIssuesReferences: [{ number: issueNumber }],
    };
  }
  override async prDiff(): Promise<string> {
    return "diff --git a/file b/file\n+added\n";
  }
  override async prStatus(): Promise<PrStatus> {
    return {
      state: "open",
      headRefOid: "sha1",
      closingIssuesReferences: [{ number: 1 }],
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
  }
  override async mergeReadiness(): Promise<MergeReadiness> {
    return {
      state: "open",
      isDraft: false,
      baseRefName: "main",
      headRefOid: "sha1",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      hasUnresolvedReviewThreads: false,
      changesRequestedStale: false,
    };
  }
  override async mergePr(repo: string, prNumber: number, headSha: string): Promise<void> {
    this.merged.push({ repo, prNumber, headSha });
  }
}

const waiting = (n: number, label: string): GhIssue => ({
  number: n,
  title: `Issue ${n}`,
  body: "",
  labels: [{ name: label }],
  comments: [
    {
      id: n,
      author: "bot",
      authorAssociation: "NONE",
      body: "<!-- factory:plan v1 -->\nThe plan\u001b[31m",
      createdAt: "2026-09-20T10:00:00Z",
    },
  ],
});

const TOKEN = "s3cret-token";
const scratch = mkdtempSync(join(tmpdir(), "factory-routes-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function make(token: string, issues: GhIssue[] = [], project?: DashboardProject) {
  const before = process.env.FACTORY_DASHBOARD_TOKEN;
  process.env.FACTORY_DASHBOARD_TOKEN = token;
  try {
    const mod = await import(`../dashboard/server.ts?token=${token || "none"}`);
    const state = new FactoryState(":memory:");
    const github = new FakeGitHub(issues);
    return {
      mod,
      state,
      github,
      dashboard: mod.createDashboard(state, github, "acme/widgets", false, scratch, undefined, undefined, project),
    };
  } finally {
    if (before === undefined) delete process.env.FACTORY_DASHBOARD_TOKEN;
    else process.env.FACTORY_DASHBOARD_TOKEN = before;
  }
}

const samplePath = (label: string) => label.split(" ")[1]!.replace(":n", "1").replace(":id", "1");
const call = (label: string, headers: Record<string, string> = {}) => {
  const [method] = label.split(" ");
  return new Request(`http://localhost:4100${samplePath(label)}`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    body: method === "POST" ? "{}" : undefined,
  });
};

describe("route walk", () => {
  test("with a token set, every route except the public allow-list is 401 without credentials", async () => {
    const { mod, dashboard } = await make(TOKEN);
    expect(dashboard.routeLabels.length).toBeGreaterThan(10);
    for (const p of mod.PUBLIC_ROUTES) expect(dashboard.routeLabels, p).toContain(p);
    for (const label of dashboard.routeLabels as string[]) {
      if (mod.PUBLIC_ROUTES.includes(label)) continue;
      for (const ip of ["127.0.0.1", "203.0.113.7"]) {
        const res = await dashboard.handle(call(label), ip);
        expect(res.status, `${label} from ${ip}`).toBe(401);
      }
    }
    // An unknown path is refused before it can 404, so routes cannot be probed.
    expect((await dashboard.handle(new Request("http://localhost:4100/api/nope"), "203.0.113.7")).status).toBe(401);
  });

  test("the token in a query string no longer works; the header and the session cookie do", async () => {
    const { dashboard } = await make(TOKEN);
    const at = (path: string, headers: Record<string, string> = {}) =>
      dashboard.handle(new Request(`http://localhost:4100${path}`, { headers }), "203.0.113.7");
    expect((await at(`/api/runs?token=${TOKEN}`)).status).toBe(401);
    expect((await at("/api/runs", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await at("/api/runs", { authorization: "Bearer wrong-token-value" })).status).toBe(401);

    const bad = await dashboard.handle(call("POST /api/session"), "203.0.113.7");
    expect(bad.status).toBe(401);
    const login = await dashboard.handle(
      new Request("http://localhost:4100/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
      "203.0.113.7",
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const secureLogin = (url: string, headers: Record<string, string> = {}) =>
      dashboard.handle(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ token: TOKEN }),
        }),
        "203.0.113.7",
      );
    expect((await secureLogin("https://dash.example/api/session")).headers.get("set-cookie")).toContain("; Secure");
    expect(
      (await secureLogin("http://localhost:4100/api/session", { "x-forwarded-proto": "https" })).headers.get(
        "set-cookie",
      ),
    ).toContain("; Secure");
    expect((await at("/api/runs", { cookie: setCookie.split(";")[0]! })).status).toBe(200);
  });

  test("no token set: a non-loopback caller is refused outright, even on the public routes", async () => {
    const { dashboard } = await make("");
    expect((await dashboard.handle(call("GET /"), "203.0.113.7")).status).toBe(503);
  });
});

describe("inbox routes", () => {
  test("a parked item leads with the reason this dashboard's DB holds", async () => {
    const { dashboard, state } = await make("", [waiting(6, LABEL.needsHuman)]);
    state.upsertRun({ issue: 6, repo: "acme/widgets", title: "t", stage: "verify", status: "running" });
    state.updateRun("acme/widgets", 6, { status: "needs-human", reason: "verify uncertain" });
    const list = (await (await dashboard.handle(call("GET /api/inbox"), "127.0.0.1")).json()) as {
      items: { ask: string }[];
    };
    expect(list.items[0]!.ask).toBe("Parked: verify uncertain\n\nThe plan");
  });

  test("lists what waits and posts the same comment a human would", async () => {
    const { dashboard, github } = await make("", [waiting(3, LABEL.awaitingApproval), waiting(4, LABEL.building)]);
    const list = (await (await dashboard.handle(call("GET /api/inbox"), "127.0.0.1")).json()) as {
      items: { issue: number; ask: string; actions: string[] }[];
    };
    expect(list.items.map((i) => i.issue)).toEqual([3]);
    expect(list.items[0]!.ask).toBe("The plan");

    const act = (n: number, body: unknown) =>
      dashboard.handle(
        new Request(`http://localhost:4100/api/inbox/${n}/act`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "127.0.0.1",
      );
    expect((await act(3, { action: "approve" })).status).toBe(200);
    // The runner's account posts it, so the comment names who sent it.
    expect(github.posted).toEqual([
      { issue: 3, body: "/factory approve\n\n<sub>Sent from the factory control plane by the local owner</sub>" },
    ]);
    expect((await act(3, { action: "retry" })).status).toBe(400);
    expect((await act(3, { action: "revise", text: " " })).status).toBe(400);
    expect((await act(4, { action: "cancel" })).status).toBe(404);
    expect(github.posted).toHaveLength(1);
  });
});

describe("review and merge routes", () => {
  test("the review route returns the diff, CI status and merge readiness for the PR that closes the issue", async () => {
    const { dashboard } = await make("", [waiting(5, LABEL.inReview)]);
    const res = await dashboard.handle(new Request("http://localhost:4100/api/issues/5/review"), "127.0.0.1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pr: { number: number };
      diff: string;
      ci: { status: string };
      gate: unknown;
      verify: unknown;
      stages: unknown[];
    };
    expect(body.pr.number).toBe(105);
    expect(body.diff).toContain("diff --git");
    expect(body.ci.status).toBe("passed");
    expect(body.gate).toBeUndefined();
    expect(body.verify).toBeNull();
    expect(body.stages).toEqual([]);
  });

  test("a route that throws answers a plain 500, never a stack trace or a server path", async () => {
    const { dashboard, github } = await make("", [waiting(5, LABEL.inReview)]);
    github.prForIssue = async () => {
      throw new Error("gh failed in /srv/factory/secret");
    };
    const res = await dashboard.handle(new Request("http://localhost:4100/api/issues/5/review"), "127.0.0.1");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: "internal error" }));
  });

  test("the review route 404s when no open PR closes the issue", async () => {
    const { dashboard } = await make("", []);
    const res = await dashboard.handle(new Request("http://localhost:4100/api/issues/9/review"), "127.0.0.1");
    expect(res.status).toBe(404);
  });

  test("approve-and-merge calls the same mergePr the automated policy uses, and posts the operator audit comment", async () => {
    const { dashboard, github } = await make("", [waiting(6, LABEL.inReview)]);
    const res = await dashboard.handle(
      new Request("http://localhost:4100/api/issues/6/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      "127.0.0.1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: { outcome: string } };
    expect(body.ok).toBe(true);
    expect(body.decision.outcome).toBe("merge");
    expect(github.merged).toEqual([{ repo: "acme/widgets", prNumber: 106, headSha: "sha1" }]);
    expect(github.posted[0]!.body).toContain("operator");
  });

  test("approve-and-merge refuses (and never calls mergePr) when readiness fails, still posting the audit comment", async () => {
    const { dashboard, github } = await make("", [waiting(7, LABEL.inReview)]);
    const original = github.mergeReadiness.bind(github);
    github.mergeReadiness = async () => ({ ...(await original()), isDraft: true });
    const res = await dashboard.handle(
      new Request("http://localhost:4100/api/issues/7/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      "127.0.0.1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: { outcome: string; refusals?: { reason: string }[] } };
    expect(body.ok).toBe(false);
    expect(body.decision.outcome).toBe("refuse");
    expect(body.decision.refusals?.map((r) => r.reason)).toContain("draft");
    expect(github.merged).toEqual([]);
    expect(github.posted[0]!.body).toContain("blocked");
  });

  describe("under a profile that wants code-owner approval", () => {
    const mergeAs = async (approvedBy: string[]) => {
      const scaleup = { ...project().config, profile: "scaleup" } as FactoryConfig;
      const { dashboard, github } = await make("", [waiting(6, LABEL.inReview)], project({ config: scaleup }));
      const original = github.mergeReadiness.bind(github);
      github.mergeReadiness = async () => ({ ...(await original()), approvedBy });
      github.fileAtRef = async (_repo, path, ref) =>
        path === ".github/CODEOWNERS" && ref === "main" ? "*.sql @dba\n" : undefined;
      github.prFiles = async () => [{ path: "db/1.sql", additions: 1, deletions: 0 }];
      const res = await dashboard.handle(
        new Request("http://localhost:4100/api/issues/6/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        "127.0.0.1",
      );
      return { github, body: (await res.json()) as { ok: boolean; decision: { refusals?: { reason: string }[] } } };
    };

    test("refuses an unapproved owner path", async () => {
      const { github, body } = await mergeAs([]);
      expect(body.ok).toBe(false);
      expect(body.decision.refusals?.map((r) => r.reason)).toContain("codeowner-approval");
      expect(github.merged).toEqual([]);
    });

    test("merges when the owner approved on GitHub", async () => {
      const { github, body } = await mergeAs(["dba"]);
      expect(body.ok).toBe(true);
      expect(github.merged).toHaveLength(1);
    });
  });

  test("the merge route 404s when no open PR closes the issue", async () => {
    const { dashboard } = await make("", []);
    const res = await dashboard.handle(
      new Request("http://localhost:4100/api/issues/9/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      "127.0.0.1",
    );
    expect(res.status).toBe(404);
  });
});

describe("multi-repo inbox", () => {
  test("aggregates across every repo under FACTORY_HOME, sorted by wait time, and ?repo= narrows it to one", async () => {
    const before = process.env.FACTORY_REPOS;
    process.env.FACTORY_REPOS = "acme/widgets,acme/gadgets";
    try {
      const { dashboard } = await make("", [waiting(3, LABEL.awaitingApproval)]);
      const all = (await (
        await dashboard.handle(new Request("http://localhost:4100/api/inbox"), "127.0.0.1")
      ).json()) as {
        repos: string[];
        items: { issue: number; repo: string }[];
      };
      expect(all.repos).toEqual(["acme/widgets", "acme/gadgets"]);
      // FakeGitHub answers the same issue list for every repo, so the same
      // issue #3 shows up once per repo, each tagged with its own repo.
      expect(all.items.map((i) => [i.repo, i.issue]).sort()).toEqual([
        ["acme/gadgets", 3],
        ["acme/widgets", 3],
      ]);
      const filtered = await dashboard.handle(
        new Request("http://localhost:4100/api/inbox?repo=acme/widgets"),
        "127.0.0.1",
      );
      expect(filtered.status).toBe(200);
      const body = (await filtered.json()) as { items: { issue: number; repo: string }[] };
      expect(body.items).toEqual([{ ...body.items[0]!, issue: 3, repo: "acme/widgets" }]);
    } finally {
      if (before === undefined) delete process.env.FACTORY_REPOS;
      else process.env.FACTORY_REPOS = before;
    }
  });

  test("inbox/:n/act resolves the repo from the request body, defaulting to the configured repo", async () => {
    const { dashboard, github } = await make("", [waiting(3, LABEL.awaitingApproval)]);
    const res = await dashboard.handle(
      new Request("http://localhost:4100/api/inbox/3/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", repo: "acme/widgets" }),
      }),
      "127.0.0.1",
    );
    expect(res.status).toBe(200);
    // The runner's account posts it, so the comment names who sent it.
    expect(github.posted).toEqual([
      { issue: 3, body: "/factory approve\n\n<sub>Sent from the factory control plane by the local owner</sub>" },
    ]);
  });
});

describe("analytics and stages", () => {
  const stage = (i: number, agent: string): StageRunInput => ({
    repo: "acme/widgets",
    issue: 1 + (i % 3),
    stage: "build",
    agent,
    model: null,
    started_at: "2026-09-24T00:00:00Z",
    finished_at: new Date().toISOString(),
    duration_ms: 1000,
    tool_calls: 1,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: 0.01,
    exit_code: i % 10 === 0 ? 1 : 0,
    killed_reason: null,
  });

  test("sums more than one page (1100 attempts) and reports per agent", async () => {
    const { dashboard, state } = await make("");
    for (let i = 0; i < 1100; i++) state.recordStageRun(stage(i, i % 2 ? "claude" : "codex"));
    const a = (await (await dashboard.handle(call("GET /api/analytics"), "127.0.0.1")).json()) as {
      spend7dUsd: number;
      byStage: { attempts: number }[];
      byAgent: { key: string; attempts: number; failures: number }[];
    };
    expect(a.byStage[0]!.attempts).toBe(1100);
    expect(a.byAgent.map((b) => [b.key, b.attempts])).toEqual([
      ["claude", 550],
      ["codex", 550],
    ]);
    expect(a.spend7dUsd).toBeCloseTo(11, 5);
    expect(a.byAgent.reduce((n, b) => n + b.failures, 0)).toBe(110);
  });

  test("savings price each attempt's tokens at its agent's large model, and count what they cannot price", async () => {
    const agents = { claude: { preset: "claude", model: "claude-haiku-5-5", models: { large: "claude-opus-5-5" } } };
    const p = project();
    const { dashboard, state } = await make("", [], { ...p, config: { ...p.config, agents } as FactoryConfig });
    const million = { tokens_in: 1_000_000, tokens_out: 0, tokens_cached: 0 };
    state.recordStageRun({ ...stage(0, "claude"), ...million, cost_usd: 0.5 });
    state.recordStageRun({ ...stage(1, "codex"), ...million, cost_usd: 0.5 });
    state.recordStageRun({ ...stage(2, "claude"), ...million, cost_usd: null, usage_complete: 0 });
    const a = (await (await dashboard.handle(call("GET /api/analytics"), "127.0.0.1")).json()) as {
      savings: { runs: number; unpriced: number; actualUsd: number; baselineUsd: number; savedUsd: number };
    };
    expect(a.savings).toEqual({ runs: 1, unpriced: 2, actualUsd: 0.5, baselineUsd: 4, savedUsd: 3.5 });
  });

  test("run stages come back for a known run and 404 for an unknown one", async () => {
    const { dashboard, state } = await make("");
    state.upsertRun({ issue: 1, repo: "acme/widgets", title: "t", stage: "build", status: "running" });
    state.recordStageRun(stage(3, "claude"));
    const run = state.listRuns("acme/widgets")[0]!;
    const ok = (await (
      await dashboard.handle(new Request(`http://localhost:4100/api/runs/${run.id}/stages`), "127.0.0.1")
    ).json()) as { stages?: unknown[] };
    expect(ok.stages).toHaveLength(1);
    expect((await dashboard.handle(new Request("http://localhost:4100/api/runs/999/stages"), "127.0.0.1")).status).toBe(
      404,
    );
  });
});

describe("artifacts", () => {
  const dir = join(scratch, "issue-9", ".factory", "runs", "issue-9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.md"), "<script>alert(1)</script>");
  writeFileSync(join(dir, "big.log"), "x".repeat(1024 * 1024 + 10));
  writeFileSync(join(scratch, "secret.txt"), "outside");
  symlinkSync(join(scratch, "secret.txt"), join(dir, "link.txt"));
  const get = async (q: string) => {
    const { dashboard } = await make("");
    return dashboard.handle(new Request(`http://localhost:4100/api/issues/9/artifacts${q}`), "127.0.0.1");
  };

  test("lists regular files, sends text only with sandbox headers, caps at 1 MiB, downloads as attachment", async () => {
    const list = (await (await get("")).json()) as { files: { name: string }[] };
    expect(list.files.map((f) => f.name).sort()).toEqual(["big.log", "plan.md"]); // the symlink is not listed;
    const res = await get("?file=plan.md");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("<script>alert(1)</script>");
    const big = await get("?file=big.log");
    expect(big.headers.get("x-artifact-truncated")).toBe("true");
    expect((await big.arrayBuffer()).byteLength).toBe(1024 * 1024);
    expect((await get("?file=plan.md&download=1")).headers.get("content-disposition")).toContain("attachment");
  });

  test("refuses traversal and a symlink that leaves the run directory", async () => {
    for (const f of ["../../../../secret.txt", "..%2Fsecret.txt", "link.txt", "missing.md"]) {
      expect((await get(`?file=${f}`)).status, f).toBe(404);
    }
  });

  test("with no workspaces given, a repo's artifacts come from its own FACTORY_HOME dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const before = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      const runs = join(home, "acme", "widgets", "workspaces", "issue-4", ".factory", "runs", "issue-4");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, "plan.md"), "the plan");
      const mod = await import("../dashboard/server");
      const dashboard = mod.createDashboard(new FactoryState(":memory:"), new GitHub(), "acme/widgets");
      const res = await dashboard.handle(new Request("http://localhost:4100/api/issues/4/artifacts"), "127.0.0.1");
      expect(JSON.stringify(await res.json())).toContain("plan.md");
    } finally {
      if (before === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an issue with no worktree lists nothing", async () => {
    const { dashboard } = await make("");
    const res = await dashboard.handle(new Request("http://localhost:4100/api/issues/77/artifacts"), "127.0.0.1");
    expect(await res.json()).toEqual({ files: [] });
  });
});

describe("line and assets", () => {
  test("/api/line lists one row per run with its stages", async () => {
    const { dashboard, state } = await make("");
    state.upsertRun({ issue: 1, repo: "acme/widgets", title: "t", stage: "build", status: "running" });
    state.recordStageRun({
      repo: "acme/widgets",
      issue: 1,
      stage: "triage",
      agent: "claude",
      model: null,
      started_at: "2026-09-24T00:00:00Z",
      finished_at: "2026-09-24T00:00:05Z",
      duration_ms: 5000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0.01,
      exit_code: 0,
      killed_reason: null,
    });
    const verify = {
      repo: "acme/widgets",
      issue: 1,
      stage: "verify",
      agent: "claude",
      model: null,
      started_at: "2026-09-24T00:00:06Z",
      finished_at: "2026-09-24T00:00:09Z",
      duration_ms: 3000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0.01,
      exit_code: 0,
      killed_reason: null,
    } as const;
    state.recordStageRun(verify);
    state.setVerifyVerdict("acme/widgets", 1, "uncertain");
    state.recordStageRun(verify);
    state.setVerifyVerdict("acme/widgets", 1, "pass");
    const body = (await (await dashboard.handle(call("GET /api/line"), "127.0.0.1")).json()) as {
      rows: { stages: { stage: string; ok: boolean }[] }[];
    };
    expect(body.rows).toHaveLength(1);
    // A clean exit with an uncertain verdict is not an ok verify; the stamp only touches the newest row.
    expect(body.rows[0]!.stages).toMatchObject([
      { stage: "triage", ok: true },
      { stage: "verify", ok: false },
      { stage: "verify", ok: true },
    ]);
  });

  test("the Line, the live feed and the proof span every repo the inbox reads", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const saved = { home: process.env.FACTORY_HOME, repos: process.env.FACTORY_REPOS };
    process.env.FACTORY_HOME = home;
    process.env.FACTORY_REPOS = "acme/widgets,acme/harness";
    try {
      const { dashboard, state } = await make("");
      state.upsertRun({ issue: 1, repo: "acme/widgets", title: "widgets bug", stage: "build", status: "running" });
      new FactoryState(join(home, "acme", "harness", "factory.db")).upsertRun({
        issue: 7,
        repo: "acme/harness",
        title: "harness bug",
        stage: "plan",
        status: "running",
      });
      const get = async (path: string) =>
        (await dashboard.handle(new Request(`http://localhost:4100${path}`), "127.0.0.1")).json();
      const line = (await get("/api/line")) as { rows: { repo: string; run: { issue: number } }[] };
      expect(line.rows.map((r) => `${r.repo}#${r.run.issue}`).sort()).toEqual(["acme/harness#7", "acme/widgets#1"]);

      const transcripts = join(home, "acme", "harness", "transcripts");
      mkdirSync(transcripts, { recursive: true });
      cpSync(join(import.meta.dir, "fixtures/agents/claude/build.jsonl"), join(transcripts, "issue-7.stream.jsonl"));
      const live = (await get("/api/issues/7/live?repo=acme/harness")) as { items: { kind: string }[]; next: number };
      expect(live.items.some((i) => i.kind === "tool")).toBe(true);
      expect(
        ((await get(`/api/issues/7/live?repo=acme/harness&from=${live.next}`)) as { items: unknown[] }).items,
      ).toEqual([]);

      cpSync(
        join(import.meta.dir, "fixtures/runs/issue-186"),
        join(home, "acme", "harness", "workspaces", "issue-7", ".factory", "runs", "issue-7"),
        { recursive: true },
      );
      const proof = (await get("/api/issues/7/proof?repo=acme/harness")) as {
        criteria: unknown[];
        gate: { status: string };
        revert: { status: string };
      };
      expect(proof).toMatchObject({ gate: { status: "GREEN" }, revert: { status: "bites" } });
      expect(proof.criteria).toHaveLength(4);
    } finally {
      for (const [k, v] of [
        ["FACTORY_HOME", saved.home],
        ["FACTORY_REPOS", saved.repos],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("assets are public, typed, and never escape dashboard/public", async () => {
    const { dashboard } = await make(TOKEN);
    const css = await dashboard.handle(new Request("http://localhost:4100/styles.css"), "10.0.0.9");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const tokens = await dashboard.handle(new Request("http://localhost:4100/tokens.css"), "10.0.0.9");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    const font = await dashboard.handle(new Request("http://localhost:4100/fonts/geist.woff2"), "10.0.0.9");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect((await dashboard.handle(new Request("http://localhost:4100/lib/..%2Fserver.js"), "10.0.0.9")).status).toBe(
      401,
    );
  });
});

// A clone with one good repo workflow, one broken one, and a route to a workflow that does not exist.
function project(over: Partial<DashboardProject> = {}): DashboardProject {
  const cloneDir = mkdtempSync(join(scratch, "clone-"));
  mkdirSync(join(cloneDir, ".factory", "workflows"), { recursive: true });
  writeFileSync(join(cloneDir, ".factory", "workflows", "broken.yml"), "name: broken\nsteps: [\n");
  const config = {
    ...DEFAULT_CONFIG,
    runtime: { gates: "box" },
    routes: {
      ...DEFAULT_CONFIG.routes,
      bug: { ...DEFAULT_CONFIG.routes?.bug, workflow: "bug-to-pr" },
      chore: { workflow: "nowhere" },
    },
  } as unknown as FactoryConfig;
  return {
    cloneDir,
    config,
    machine: { slots: 3, runtimes: { box: { kind: "ssh", host: "build-1", dir: "/w" } } },
    // Never dial build-1: the Settings route probes each runtime the repo uses.
    probe: async () => ({ ok: true, ms: 1, detail: "factory-probe-ok" }),
    leases: async () => [
      { key: "issue-4", holder: "laptop", expiresAt: Date.now() + 20_000 },
      { key: "issue-5", holder: "ci", expiresAt: 0 },
    ],
    ...over,
  };
}

describe("workflows and settings", () => {
  test("with no repo dir, both pages say how to get one instead of guessing", async () => {
    const { dashboard } = await make("");
    for (const path of ["/api/workflows", "/api/settings"]) {
      const body = (await (
        await dashboard.handle(new Request(`http://localhost:4100${path}`), "127.0.0.1")
      ).json()) as { available: boolean; reason: string };
      expect(body).toMatchObject({ available: false });
      expect(body.reason).toContain("--repo-dir");
    }
  });

  test("/api/workflows is the harness report: every workflow, its routes, and each problem", async () => {
    const { dashboard } = await make("", [], project());
    const body = (await (
      await dashboard.handle(new Request("http://localhost:4100/api/workflows"), "127.0.0.1")
    ).json()) as {
      problems: string[];
      workflows: { name: string; source: string; routedTypes: string[]; problems: string[]; steps: { id: string }[] }[];
    };
    const byName = Object.fromEntries(body.workflows.map((w) => [w.name, w]));
    expect(byName.broken).toMatchObject({ source: "repo", steps: [] });
    expect(byName.broken!.problems.length).toBeGreaterThan(0);
    expect(byName["bug-to-pr"]).toMatchObject({ source: "runner", routedTypes: ["bug"] });
    expect(byName["feature-to-pr"]!.routedTypes).toContain("*");
    expect(byName["feature-to-pr"]!.steps.length).toBeGreaterThan(3);
    expect(body.problems.some((p) => p.startsWith(".factory/workflows/broken.yml"))).toBe(true);
    expect(body.problems.some((p) => p.startsWith("routes.chore.workflow"))).toBe(true);
  });

  test("/api/settings lists built-in and machine runtimes with what uses them, and every lease", async () => {
    const { dashboard } = await make("", [], project());
    const body = (await (
      await dashboard.handle(new Request("http://localhost:4100/api/settings"), "127.0.0.1")
    ).json()) as {
      slots: number;
      runtimes: { name: string; kind: string; builtin: boolean; target: string; usedBy: string[] }[];
      leases: { key: string; live: boolean }[];
      leasesError: string | null;
    };
    expect(body.slots).toBe(3);
    expect(body.runtimes.map((r) => r.name)).toEqual(["default", "local", "lwpr", "box"]);
    expect(body.runtimes.find((r) => r.name === "box")).toMatchObject({
      kind: "ssh",
      builtin: false,
      target: "build-1:/w",
      usedBy: ["runtime.gates"],
    });
    expect(body.runtimes.find((r) => r.name === "local")).toMatchObject({ builtin: true, usedBy: [] });
    expect(body.leases).toEqual([
      expect.objectContaining({ key: "issue-4", live: true }),
      expect.objectContaining({ key: "issue-5", live: false }),
    ]);
    expect(body.leasesError).toBeNull();
  });

  test("a remote that cannot be read is said on the page, and the rest still loads", async () => {
    const { dashboard } = await make(
      "",
      [],
      project({
        leases: async () => {
          throw new Error("git ls-remote: no route to host");
        },
      }),
    );
    const res = await dashboard.handle(new Request("http://localhost:4100/api/settings"), "127.0.0.1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ leases: [], leasesError: "git ls-remote: no route to host" });
  });
});

describe("session cookie and terminal-safe text", () => {
  const ESC = "\u001b[31m";

  test("the cookie is a random id, not the token, and it is not accepted as a Bearer token", async () => {
    const { dashboard } = await make(TOKEN);
    const login = async () =>
      dashboard.handle(
        new Request("http://localhost:4100/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN }),
        }),
        "203.0.113.7",
      );
    const one = (await login()).headers.get("set-cookie")!;
    const two = (await login()).headers.get("set-cookie")!;
    expect(one).not.toContain(TOKEN);
    expect(one.split(";")[0]).not.toBe(two.split(";")[0]);
    const id = one.split(";")[0]!.split("=")[1]!;
    const at = (headers: Record<string, string>) =>
      dashboard.handle(new Request("http://localhost:4100/api/runs", { headers }), "203.0.113.7");
    expect((await at({ authorization: `Bearer ${id}` })).status).toBe(401);
    expect((await at({ cookie: `factory_session=${TOKEN}` })).status).toBe(401);
    expect((await at({ cookie: `factory_session=${id}` })).status).toBe(200);
  });

  test("thread, run titles and artifact previews carry no terminal escapes; a download stays raw", async () => {
    const issue: GhIssue = {
      number: 1,
      title: `T${ESC}`,
      body: `B${ESC}`,
      labels: [],
      comments: [{ id: 1, author: "a", authorAssociation: "NONE", body: `C${ESC}`, createdAt: "2026-09-20T10:00:00Z" }],
    };
    const { dashboard, state } = await make("", [issue]);
    state.upsertRun({ issue: 1, repo: "acme/widgets", title: `Run${ESC}`, stage: "build", status: "running" });
    const dir = join(scratch, "issue-1", ".factory", "runs", "issue-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.md"), `plan${ESC}`);
    const get = async (path: string) => dashboard.handle(new Request(`http://localhost:4100${path}`), "127.0.0.1");
    for (const path of ["/api/runs", "/api/issues/1/thread", "/api/issues/1/artifacts?file=plan.md", "/api/line"])
      expect(await (await get(path)).text(), path).not.toContain("\u001b");
    expect(await (await get("/api/issues/1/artifacts?file=plan.md&download=1")).text()).toContain("\u001b");
  });
});

describe("text is plain()-ed on every read route", () => {
  const ESC = "\u001b[31m";
  // JSON escapes ESC as \u001b, so look for both spellings.
  const dirty = (s: string) => s.includes("\u001b") || s.includes("\\u001b");

  test("no GET route returns an escape sequence that came from an issue, agent or artifact", async () => {
    const issue: GhIssue = {
      number: 1,
      title: `t${ESC}`,
      body: `b${ESC}`,
      labels: [{ name: LABEL.needsInfo }],
      comments: [
        {
          id: 1,
          author: "bot",
          authorAssociation: "NONE",
          body: `<!-- factory:plan v1 -->\nplan${ESC}`,
          createdAt: "2026-09-20T10:00:00Z",
        },
      ],
    };
    const { mod, dashboard, state } = await make(
      "",
      [issue],
      project({
        leases: async () => [{ key: "issue-1", holder: `w${ESC}`, expiresAt: 1 }],
        machine: { slots: 1, runtimes: { box: { kind: "docker", image: `img${ESC}` } } },
      }),
    );
    const run = state.upsertRun({
      issue: 1,
      repo: "acme/widgets",
      title: `run${ESC}`,
      stage: "build",
      status: "running",
    });
    state.appendEvent(run.id, "build", "text", `event${ESC}`);
    state.recordStageRun({
      repo: "acme/widgets",
      issue: 1,
      stage: "build",
      agent: `agent${ESC}`,
      model: null,
      started_at: "2026-09-24T00:00:00Z",
      finished_at: "2026-09-24T00:00:01Z",
      duration_ms: 1000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0,
      exit_code: 1,
      killed_reason: `killed${ESC}`,
    });
    const dir = join(scratch, "issue-1", ".factory", "runs", "issue-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.md"), `plan${ESC}`);

    const gets = (dashboard.routeLabels as string[]).filter(
      (l) => l.startsWith("GET ") && !mod.PUBLIC_ROUTES.includes(l) && l !== "GET /api/stream",
    );
    expect(gets.length).toBeGreaterThan(8);
    process.env.FACTORY_AGUI = "1";
    for (const label of gets) {
      const url = `http://localhost:4100${samplePath(label).replace(/\/artifacts$/, "/artifacts?file=plan.md")}`;
      const res = await dashboard.handle(new Request(url.replace(/^(.*\/runs\/)1/, `$1${run.id}`)), "127.0.0.1");
      expect(res.status, label).toBe(200);
      expect(dirty(await res.text()), label).toBe(false);
    }
    delete process.env.FACTORY_AGUI;
  });
});

// The service worker run against stubs: what it precaches, and which fetches it answers.
function loadWorker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
    location: { origin: "http://localhost:4100" },
  };
  const src = readFileSync(join(import.meta.dir, "..", "dashboard", "public", "sw.js"), "utf8");
  const shell = new Function("self", "caches", "fetch", `${src}\nreturn SHELL;`)(
    self,
    {},
    () => new Promise(() => {}),
  ) as string[];
  const answers = (method: string, path: string) => {
    let answered = false;
    listeners.fetch!({
      request: { method, url: `http://localhost:4100${path}` },
      respondWith: () => (answered = true),
      waitUntil: () => {},
    });
    return answered;
  };
  return { shell, answers };
}

describe("the cockpit installs as an app", () => {
  test("every file the worker precaches is public, so install works before sign-in", async () => {
    const { dashboard } = await make(TOKEN);
    for (const path of loadWorker().shell) {
      const res = await dashboard.handle(new Request(`http://localhost:4100${path}`), "203.0.113.7");
      expect(res.status, path).toBe(200);
    }
  });

  test("the worker precaches every page module, so the cockpit opens offline", () => {
    const lib = readdirSync(join(import.meta.dir, "..", "dashboard", "public", "lib")).filter((f) => f.endsWith(".js"));
    expect(loadWorker().shell).toEqual(expect.arrayContaining(["/", ...lib.map((f) => `/lib/${f}`)]));
  });

  test("the worker never answers for the API or a write, so no run data is stored", () => {
    const { answers } = loadWorker();
    expect(answers("GET", "/app.js")).toBe(true);
    expect(answers("GET", "/index.html")).toBe(true);
    expect(answers("GET", "/api/inbox")).toBe(false);
    expect(answers("GET", "/api/runs/1")).toBe(false);
    expect(answers("POST", "/api/session")).toBe(false);
  });

  test("the manifest is served as one, starts inside its scope, and names a served icon", async () => {
    const { dashboard } = await make(TOKEN);
    const res = await dashboard.handle(new Request("http://localhost:4100/manifest.webmanifest"), "203.0.113.7");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = (await res.json()) as { start_url: string; scope: string; display: string; icons: { src: string }[] };
    expect(m.start_url.startsWith(m.scope)).toBe(true);
    expect(m.display).toBe("standalone");
    for (const icon of m.icons) expect(loadWorker().shell).toContain(icon.src);
  });
});
