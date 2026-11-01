import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenAuth } from "../src/api/auth";
import { coreRoutes } from "../src/api/core";
import { LiveFeed } from "../src/api/stream";
import { getTaskReport, metricsFor } from "../src/metrics-get";
import { FactoryState } from "../src/state";

const REPO = "acme/web";

function open(): { state: FactoryState; done: () => void } {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "metrics-get-"));
  return { state: new FactoryState(join(dir, "state.db")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(state: FactoryState, issue: number, status: "shipped" | "failed", verdict: string, cost: number | null) {
  state.upsertRun({ issue, repo: REPO, title: `Issue ${issue}`, stage: "pr", status });
  state.recordStageRun({
    repo: REPO,
    issue,
    stage: "verify",
    agent: "claude",
    model: null,
    started_at: "2026-10-30T10:00:00.000Z",
    finished_at: "2026-10-30T10:01:00.000Z",
    duration_ms: 60000,
    tool_calls: 1,
    tokens_in: 1,
    tokens_out: 1,
    cost_usd: cost,
    usage_complete: cost === null ? 0 : 1,
    exit_code: 0,
    killed_reason: null,
  });
  state.setVerifyVerdict(REPO, issue, verdict);
}

describe("metricsFor", () => {
  test("empty state omits every metric instead of showing zero", () => {
    const { state, done } = open();
    expect(metricsFor([{ repo: REPO, state }], { operator: true })).toEqual({});
    done();
  });

  test("computes rates and keeps cost operator-only", () => {
    const { state, done } = open();
    seed(state, 1, "shipped", "pass", 2);
    seed(state, 2, "failed", "reject", 4);
    const src = [{ repo: REPO, state }];
    expect(metricsFor(src, { operator: true })).toEqual({ mergeRate: 0.5, judgeVetoRate: 0.5, costPerMergedChange: 2 });
    expect(metricsFor(src, { operator: false })).toEqual({ mergeRate: 0.5, judgeVetoRate: 0.5 });
    done();
  });

  test("unknown cost omits cost rather than understating it", () => {
    const { state, done } = open();
    seed(state, 1, "shipped", "pass", null);
    expect(metricsFor([{ repo: REPO, state }], { operator: true })).toEqual({ mergeRate: 1, judgeVetoRate: 0 });
    done();
  });
});

describe("getTaskReport", () => {
  test("hides cost from non-operators and returns undefined for an unknown issue", () => {
    const { state, done } = open();
    seed(state, 1, "shipped", "pass", 2);
    expect(getTaskReport(REPO, state, 1, { operator: false })).toEqual({
      repo: REPO,
      issue: 1,
      status: "shipped",
      stages: [{ stage: "verify", verdict: "pass" }],
    });
    expect(getTaskReport(REPO, state, 1, { operator: true })?.costUsd).toBe(2);
    expect(getTaskReport(REPO, state, 9, { operator: true })).toBeUndefined();
    done();
  });
});

describe("GET /api/metrics", () => {
  test("serves cost only to the operator token", async () => {
    const { state, done } = open();
    seed(state, 1, "shipped", "pass", 2);
    const api = coreRoutes({
      repos: () => [REPO],
      state: () => state,
      feed: new LiveFeed(),
      auth: tokenAuth({ FACTORY_API_TOKEN: "user-tok" }),
      operator: tokenAuth({ FACTORY_API_TOKEN: "op-tok" }),
    });
    const ask = async (tok: string) =>
      (await (
        await api.fetch(new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${tok}` } }))
      ).json()) as unknown;
    expect(await ask("user-tok")).toEqual({ metrics: { mergeRate: 1, judgeVetoRate: 0 } });
    expect(await ask("op-tok")).toEqual({ metrics: { mergeRate: 1, judgeVetoRate: 0, costPerMergedChange: 2 } });
    expect((await api.fetch(new Request("http://x/api/metrics"))).status).toBe(401);
    done();
  });
});
