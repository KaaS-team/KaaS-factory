import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryAdapter } from "../src/mc/adapters/factory";
import { adapterKit } from "../src/mc/kit";
import { SessionUnsupported, type SessionEvent } from "../src/ports/session";
import { FactoryState, type RunStatus } from "../src/state";

const REPO = "o/r";

function fixture(status: RunStatus = "running", over: { pr?: string | null; reason?: string | null } = {}) {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "mc-factory-"));
  const state = new FactoryState(join(dir, "state.db"));
  const run = state.upsertRun({ issue: 7, repo: REPO, title: "Add a thing", stage: "build", status });
  state.updateRun(REPO, 7, { pr_url: over.pr ?? null, reason: over.reason ?? null });
  const stage = (cost: number | null, agent = "claude", session_id: string | null = null) =>
    state.recordStageRun({
      repo: REPO,
      issue: 7,
      stage: "build",
      agent,
      model: "m",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:01:00Z",
      duration_ms: 60000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: cost,
      exit_code: 0,
      killed_reason: null,
      session_id,
    });
  const posted: string[] = [];
  const tracker = {
    async getIssue() {
      return {
        number: 7,
        title: "Add a thing",
        body: "",
        labels: [{ name: status === "awaiting-approval" ? "factory:awaiting-approval" : "factory:needs-info" }],
        comments: [],
      };
    },
    async commentIssue(_r: string, _i: number, body: string) {
      posted.push(body);
      return 1;
    },
    async createIssue() {
      return 1;
    },
    async addLabels() {},
  };
  const adapter = (dashboardUrl?: string) =>
    factoryAdapter({ state, repos: () => [REPO], tracker: tracker as never, actor: "bot", dashboardUrl });
  return { dir, state, run, stage, posted, adapter, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("factory adapter", () => {
  test("passes the adapter kit", async () => {
    // The kit's followUp probe needs a run that waits for someone.
    const f = fixture("needs-info");
    f.stage(0.5);
    const checks = await adapterKit(f.adapter("https://dash.example.com"), {
      ref: { runtime: "factory", connection: "factory", externalId: `${REPO}#7` },
    });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    f.done();
  });

  test("a shipped run with a PR links to the PR", async () => {
    const f = fixture("shipped", { pr: "https://github.com/o/r/pull/9" });
    const [row] = await f.adapter("https://dash.example.com").list();
    expect(row!.state).toBe("succeeded");
    expect(row!.link).toBe("https://github.com/o/r/pull/9");
    expect(row!.prUrl).toBe("https://github.com/o/r/pull/9");
    f.done();
  });

  test("without a PR the link is the dashboard run page, and absent for a non-https dashboard", async () => {
    const f = fixture();
    expect((await f.adapter("https://dash.example.com/").list())[0]!.link).toBe(
      `https://dash.example.com/runs/${f.run.id}`,
    );
    expect((await f.adapter("http://dash.example.com").list())[0]!.link).toBeUndefined();
    expect((await f.adapter().list())[0]!.link).toBeUndefined();
    f.done();
  });

  test("an unknown cost is null, never 0; known costs add up", async () => {
    const f = fixture();
    f.stage(1.5);
    expect((await f.adapter().list())[0]!.costUsd).toBe(1.5);
    f.stage(null);
    expect((await f.adapter().list())[0]!.costUsd).toBeNull();
    f.done();
  });

  test("a waiting run says why in needsYou", async () => {
    const f = fixture("needs-info", { reason: "which database?" });
    expect((await f.adapter().list())[0]!.needsYou).toBe("which database?");
    f.done();
  });

  test("a cloud session id becomes a child row; a local harness does not", async () => {
    const f = fixture();
    f.stage(1, "cursor", "cur-123");
    f.stage(1, "claude", null);
    f.stage(1, "pi", "pi-1");
    const rows = await f.adapter().list();
    const kids = rows.filter((r) => r.ref.runtime !== "factory");
    expect(kids.map((r) => r.ref)).toEqual([{ runtime: "cursor", connection: "factory", externalId: "cur-123" }]);
    expect(kids[0]).toMatchObject({ repo: REPO, issue: 7, stage: "build" });
    f.done();
  });

  test("a follow-up to a run waiting for approval is a revise", async () => {
    const f = fixture("awaiting-approval");
    await f.adapter().followUp({ runtime: "factory", connection: "factory", externalId: `${REPO}#7` }, "use a map");
    expect(f.posted.join("\n")).toContain("/factory revise");
    f.done();
  });

  test("a follow-up to a run waiting for information is an answer", async () => {
    const f = fixture("needs-info");
    await f.adapter().followUp({ runtime: "factory", connection: "factory", externalId: `${REPO}#7` }, "postgres");
    expect(f.posted.join("\n")).toContain("postgres");
    f.done();
  });

  test("a follow-up to a run nobody waits on throws SessionUnsupported", async () => {
    const f = fixture("running");
    const p = f.adapter().followUp({ runtime: "factory", connection: "factory", externalId: `${REPO}#7` }, "x");
    await expect(p).rejects.toBeInstanceOf(SessionUnsupported);
    f.done();
  });

  test("follow maps events, cuts text to 280 and resolves with the last id", async () => {
    const f = fixture();
    f.state.appendEvent(f.run.id, "build", "text", "x".repeat(400));
    f.state.appendEvent(f.run.id, "build", "text", "second");
    const seen: SessionEvent[] = [];
    const ctl = new AbortController();
    const done = f
      .adapter()
      .follow(
        { runtime: "factory", connection: "factory", externalId: `${REPO}#7` },
        undefined,
        (e) => seen.push(e),
        ctl.signal,
      );
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    const cursor = await done;
    expect(seen.map((e) => e.kind)).toEqual(["note", "note"]);
    expect(seen[0]!.text).toHaveLength(280);
    expect(Number(cursor)).toBeGreaterThan(0);
    f.done();
  });
});
