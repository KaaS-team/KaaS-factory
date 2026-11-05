// ?team=<name> narrows runs, spend (analytics) and the inbox to the repos that team lists.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { GitHub, type GhIssue, type GhPr } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { createDashboard } from "../dashboard/server";

class Fake extends GitHub {
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [{ number: 3, title: "t", body: "", labels: [{ name: LABEL.awaitingApproval }], comments: [] }];
  }
  override async listPrs(): Promise<GhPr[]> {
    return [];
  }
  override async listIssuesByLabel() {
    return [];
  }
}

mkdirSync(tmpdir(), { recursive: true });
const clone = mkdtempSync(join(tmpdir(), "dash-team-"));
afterAll(() => rmSync(clone, { recursive: true, force: true }));
const teams = join(clone, ".factory", "team", "teams");
mkdirSync(teams, { recursive: true });
writeFileSync(join(teams, "web.yml"), "name: web\nrepos: [acme/widgets]\n");
writeFileSync(join(teams, "ops.yml"), "name: ops\nrepos: [acme/gadgets]\n");

function build() {
  const state = new FactoryState(":memory:");
  state.upsertRun({ issue: 1, repo: "acme/widgets", title: "w", stage: "build", status: "running" });
  state.recordStageRun({
    repo: "acme/widgets",
    issue: 1,
    stage: "build",
    agent: "claude",
    model: null,
    started_at: "2026-09-24T00:00:00Z",
    finished_at: new Date().toISOString(),
    duration_ms: 1,
    tool_calls: 1,
    tokens_in: 1,
    tokens_out: 1,
    cost_usd: 2,
    exit_code: 0,
    killed_reason: null,
  } as never);
  const project = { cloneDir: clone, config: DEFAULT_CONFIG } as never;
  return createDashboard(state, new Fake(), "acme/widgets", false, clone, undefined, undefined, project);
}

const get = async (d: ReturnType<typeof build>, path: string) =>
  (await (await d.handle(new Request(`http://localhost:4100${path}`), "127.0.0.1")).json()) as {
    runs: unknown[];
    rows: unknown[];
    items: { repo: string }[];
    spend7dUsd: number;
  };

test("runs, spend and the inbox follow the team filter", async () => {
  const before = process.env.FACTORY_REPOS;
  process.env.FACTORY_REPOS = "acme/widgets,acme/gadgets";
  try {
    const d = build();
    expect((await get(d, "/api/runs")).runs).toHaveLength(1);
    expect((await get(d, "/api/runs?team=web")).runs).toHaveLength(1);
    expect((await get(d, "/api/runs?team=ops")).runs).toHaveLength(0);
    expect((await get(d, "/api/line?team=web")).rows).toHaveLength(1);
    expect((await get(d, "/api/line?team=ops")).rows).toHaveLength(0);
    expect((await get(d, "/api/analytics?team=web")).spend7dUsd).toBeCloseTo(2, 5);
    expect((await get(d, "/api/analytics?team=ops")).spend7dUsd).toBe(0);
    const all = await get(d, "/api/inbox");
    expect(all.items.map((i) => i.repo).sort()).toEqual(["acme/gadgets", "acme/widgets"]);
    const web = await get(d, "/api/inbox?team=web");
    expect(web.items.map((i) => i.repo)).toEqual(["acme/widgets"]);
    expect((await get(d, "/api/inbox?team=nope")).items ?? []).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.FACTORY_REPOS;
    else process.env.FACTORY_REPOS = before;
  }
});
