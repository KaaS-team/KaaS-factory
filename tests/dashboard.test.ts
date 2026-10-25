// Before this file, dashboard/server.ts had no tests at all. Covers the new
// boundary work (audit finding #16 — no auth, CSRF-able via text/plain) and
// the new label-backed /api/board + /api/mark-ready + issue-thread routes.
// FACTORY_DASHBOARD_TOKEN is read once at module load, so these tests set it
// via `--env` at the process level... instead this file drives the
// loopback-only path (the common case) explicitly and a second describe
// block re-imports the module with the token set via a subprocess, since a
// top-level `const` can't be swapped mid-test-run in the same process.

import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, type GhIssue } from "../src/github";
import { FactoryState } from "../src/state";
import { LABEL } from "../src/labels";

const LOOPBACK = "127.0.0.1";

class FakeGitHub extends GitHub {
  addLabelsCalls: { issue: number; labels: string[] }[] = [];
  constructor(private readonly issues: GhIssue[]) {
    super();
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return this.issues;
  }
  override async addLabels(_repo: string, issue: number, labels: string[]): Promise<void> {
    this.addLabelsCalls.push({ issue, labels });
  }
  override async getIssue(_repo: string, number: number): Promise<GhIssue> {
    return {
      number,
      title: "An issue",
      body: "body",
      labels: [],
      comments: [
        { id: 1, author: "octocat", authorAssociation: "OWNER", body: "hello", createdAt: new Date().toISOString() },
      ],
    };
  }
}

function issue(number: number, title: string, labelNames: string[] = []): GhIssue {
  return { number, title, body: "", labels: labelNames.map((name) => ({ name })), comments: [] };
}

async function freshDashboard(issues: GhIssue[] = []) {
  const { createDashboard } = await import("../dashboard/server");
  const state = new FactoryState(":memory:");
  const github = new FakeGitHub(issues);
  return { dashboard: createDashboard(state, github, "acme/widgets"), github, state };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:4100${path}`, init);
}

function jsonPost(path: string, body: unknown, init?: RequestInit): Request {
  const { headers, ...rest } = init ?? {};
  return req(path, {
    method: "POST",
    ...rest,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

describe("dashboard (no FACTORY_DASHBOARD_TOKEN set — the default local case)", () => {
  test("serves the loopback caller normally", async () => {
    const { dashboard } = await freshDashboard();
    const res = await dashboard.handle(req("/api/runs"), LOOPBACK);
    expect(res.status).toBe(200);
  });

  test("refuses a request with an unknown/non-loopback remote address", async () => {
    const { dashboard } = await freshDashboard();
    const res = await dashboard.handle(req("/api/runs"), "203.0.113.7");
    expect(res.status).toBe(503);
  });

  test("refuses a request with no remote address at all (fails closed, not open)", async () => {
    const { dashboard } = await freshDashboard();
    const res = await dashboard.handle(req("/api/runs"));
    expect(res.status).toBe(503);
  });

  test("GET /api/board builds cards from GitHub labels", async () => {
    const { dashboard } = await freshDashboard([
      issue(1, "Fix login", ["bug"]),
      issue(2, "Upgrade hono", [LABEL.building]),
    ]);
    const res = await dashboard.handle(req("/api/board"), LOOPBACK);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cards: { issue: number; column: string }[] };
    expect(data.cards).toHaveLength(2);
    expect(data.cards.find((c) => c.issue === 1)!.column).toBe("intake");
    expect(data.cards.find((c) => c.issue === 2)!.column).toBe("build");
  });

  test("POST /api/mark-ready labels the issue and invalidates the board cache", async () => {
    const { dashboard, github } = await freshDashboard([issue(1, "Fix login", ["bug"])]);
    const before = await (await dashboard.handle(req("/api/board"), LOOPBACK)).json();
    expect((before as { cards: { needsMarkReady: boolean }[] }).cards[0]!.needsMarkReady).toBe(true);

    const res = await dashboard.handle(jsonPost("/api/mark-ready", { issue: 1 }), LOOPBACK);
    expect(res.status).toBe(200);
    expect(github.addLabelsCalls).toEqual([{ issue: 1, labels: [LABEL.ready] }]);
  });

  test("POST /api/mark-ready rejects a non-integer issue", async () => {
    const { dashboard } = await freshDashboard();
    const res = await dashboard.handle(jsonPost("/api/mark-ready", { issue: "not-a-number" }), LOOPBACK);
    expect(res.status).toBe(400);
  });

  test("GET /api/issues/:n/thread returns the issue's comments", async () => {
    const { dashboard } = await freshDashboard();
    const res = await dashboard.handle(req("/api/issues/7/thread"), LOOPBACK);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { issue: GhIssue };
    expect(data.issue.number).toBe(7);
    expect(data.issue.comments).toHaveLength(1);
  });

  test("rejects a mutating request whose content-type is not application/json (CSRF)", async () => {
    const { dashboard } = await freshDashboard([issue(1, "x")]);
    const res = await dashboard.handle(
      req("/api/mark-ready", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ issue: 1 }),
      }),
      LOOPBACK,
    );
    expect(res.status).toBe(415);
  });

  test("rejects a cross-origin mutating request", async () => {
    const { dashboard } = await freshDashboard([issue(1, "x")]);
    const res = await dashboard.handle(
      jsonPost("/api/mark-ready", { issue: 1 }, { headers: { origin: "https://evil.example" } }),
      LOOPBACK,
    );
    expect(res.status).toBe(403);
  });

  test("allows a same-origin mutating request with an Origin header", async () => {
    const { dashboard } = await freshDashboard([issue(1, "x")]);
    const res = await dashboard.handle(
      jsonPost("/api/mark-ready", { issue: 1 }, { headers: { origin: "http://localhost:4100" } }),
      LOOPBACK,
    );
    expect(res.status).toBe(200);
  });
});

describe("dashboard with FACTORY_DASHBOARD_TOKEN set", () => {
  // The token is read once at module import, so this exercises it out of
  // process — a direct proof that a non-loopback caller with the right
  // bearer token is let in, and the wrong token is refused, without
  // polluting the module-scope constant for every other test in this file.
  test("bearer token lets a non-loopback caller through; a wrong token is refused", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const script = `
      process.env.FACTORY_DASHBOARD_TOKEN = "secret-token";
      const { createDashboard } = await import(${JSON.stringify(join(repoRoot, "dashboard", "server.ts"))});
      const { FactoryState } = await import(${JSON.stringify(join(repoRoot, "src", "state.ts"))});
      const { GitHub } = await import(${JSON.stringify(join(repoRoot, "src", "github.ts"))});
      const state = new FactoryState(":memory:");
      class Fake extends GitHub {}
      const dashboard = createDashboard(state, new Fake(), "");
      const ok = await dashboard.handle(new Request("http://x/api/runs", { headers: { authorization: "Bearer secret-token" } }), "203.0.113.7");
      const bad = await dashboard.handle(new Request("http://x/api/runs", { headers: { authorization: "Bearer wrong" } }), "203.0.113.7");
      console.log(JSON.stringify({ ok: ok.status, bad: bad.status }));
    `;
    const scriptPath = join(tmpdir(), `factory-dashboard-token-${Date.now()}.ts`);
    writeFileSync(scriptPath, script);
    try {
      const proc = Bun.spawnSync(["bun", "run", scriptPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
      const out = proc.stdout.toString().trim().split("\n").pop() ?? "{}";
      if (!out.startsWith("{")) throw new Error(`subprocess failed: ${proc.stderr.toString()}`);
      const result = JSON.parse(out) as { ok: number; bad: number };
      expect(result.ok).toBe(200);
      expect(result.bad).toBe(401);
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });
});
