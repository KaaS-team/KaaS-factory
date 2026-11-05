// `?team=` splits a repo that several teams list, issue by issue, and the cockpit has a control for it.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard } from "../dashboard/server";
import { DEFAULT_CONFIG } from "../src/config";
import { type GhIssue, GitHub, type GhPr } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";

const issue = (number: number, label: string): GhIssue => ({
  number,
  title: `t${number}`,
  body: "",
  labels: [{ name: LABEL.awaitingApproval }, { name: label }],
  comments: [],
});

class Fake extends GitHub {
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [issue(1, "area:web"), issue(2, "area:api")];
  }
  override async listPrs(): Promise<GhPr[]> {
    return [];
  }
  override async listIssuesByLabel() {
    return [];
  }
}

mkdirSync(tmpdir(), { recursive: true });
const clone = mkdtempSync(join(tmpdir(), "dash-team-issue-"));
afterAll(() => rmSync(clone, { recursive: true, force: true }));
const teams = join(clone, ".factory", "team", "teams");
mkdirSync(teams, { recursive: true });
writeFileSync(join(teams, "web.yml"), "name: web\nrepos: [acme/mono]\nowns:\n  labels: [area:web]\n");
writeFileSync(join(teams, "api.yml"), "name: api\nrepos: [acme/mono]\nowns:\n  labels: [area:api]\n");

function build() {
  const state = new FactoryState(":memory:");
  for (const n of [1, 2]) {
    state.upsertRun({ issue: n, repo: "acme/mono", title: `t${n}`, stage: "build", status: "running" });
    state.recordStageRun({
      repo: "acme/mono",
      issue: n,
      stage: "build",
      agent: "claude",
      model: null,
      started_at: "2026-09-24T00:00:00Z",
      finished_at: new Date().toISOString(),
      duration_ms: 1,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: n === 1 ? 2 : 5,
      exit_code: 0,
      killed_reason: null,
    } as never);
  }
  const project = { cloneDir: clone, config: DEFAULT_CONFIG } as never;
  return createDashboard(state, new Fake(), "acme/mono", false, clone, undefined, undefined, project);
}

const get = async (d: ReturnType<typeof build>, path: string) =>
  (await (await d.handle(new Request(`http://localhost:4100${path}`), "127.0.0.1")).json()) as {
    runs: { issue: number }[];
    items: { issue: number }[];
    spend7dUsd: number;
    teams: string[];
  };

test("runs, spend and the inbox keep only the issues the team owns in a shared repo", async () => {
  const before = process.env.FACTORY_REPOS;
  process.env.FACTORY_REPOS = "acme/mono";
  try {
    const d = build();
    expect((await get(d, "/api/runs")).runs).toHaveLength(2);
    expect((await get(d, "/api/runs?team=web")).runs.map((r) => r.issue)).toEqual([1]);
    expect((await get(d, "/api/runs?team=api")).runs.map((r) => r.issue)).toEqual([2]);
    expect((await get(d, "/api/analytics?team=web")).spend7dUsd).toBeCloseTo(2, 5);
    expect((await get(d, "/api/analytics?team=api")).spend7dUsd).toBeCloseTo(5, 5);
    expect((await get(d, "/api/inbox?team=web")).items.map((i) => i.issue)).toEqual([1]);
    expect((await get(d, "/api/inbox?team=api")).items.map((i) => i.issue)).toEqual([2]);
    expect((await get(d, "/api/teams")).teams).toEqual(["api", "web"]);
  } finally {
    if (before === undefined) delete process.env.FACTORY_REPOS;
    else process.env.FACTORY_REPOS = before;
  }
});

test("the cockpit has a team control that adds ?team= to runs, spend and the inbox", async () => {
  type Kid = El | string;
  class El {
    kids: Kid[] = [];
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: unknown) => unknown)[]> = {};
    className = "";
    constructor(public tag: string) {}
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    append(...k: Kid[]) {
      this.kids.push(...k);
    }
    replaceChildren(...k: Kid[]) {
      this.kids = k;
    }
    addEventListener(t: string, f: (e: unknown) => unknown) {
      (this.listeners[t] ??= []).push(f);
    }
    all(pred: (e: El) => boolean): El[] {
      const own = pred(this) ? [this] : [];
      return [...own, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.all(pred)))];
    }
  }
  const nav = new El("nav");
  const realDoc = (globalThis as { document?: unknown }).document;
  Object.assign(globalThis, {
    document: {
      createElement: (t: string) => new El(t),
      createElementNS: (_n: string, t: string) => new El(t),
      getElementById: (id: string) => (id === "nav" ? nav : new El("div")),
    },
  });
  try {
    const lib = "../dashboard/public/lib";
    const { state, shell, withTeam } = await import(`${lib}/core.js`);
    const { renderNav } = await import(`${lib}/rail.js`);
    const picked: string[] = [];
    Object.assign(shell, { setTeam: (t: string) => picked.push(t) });
    state.route = { view: "inbox" };
    state.data = {};
    state.teams = ["api", "web"];
    renderNav();
    const select = nav.all((e) => e.attrs.id === "team-filter")[0] as El;
    expect(select.tag).toBe("select");
    expect(select.all((e) => e.tag === "option").length).toBe(3);
    select.listeners.change?.[0]?.({ target: { value: "web" } });
    expect(picked).toEqual(["web"]);

    state.teamFilter = "web";
    expect(withTeam("/api/runs")).toBe("/api/runs?team=web");
    expect(withTeam("/api/analytics")).toBe("/api/analytics?team=web");
    expect(withTeam("/api/inbox?repo=a%2Fb")).toBe("/api/inbox?repo=a%2Fb&team=web");
    expect(withTeam("/api/agents")).toBe("/api/agents");
    state.teamFilter = "";
    expect(withTeam("/api/runs")).toBe("/api/runs");
  } finally {
    Object.assign(globalThis, { document: realDoc });
  }
});
