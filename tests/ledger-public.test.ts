// Goal public-dashboard: the public ledger says what shipped and what it cost, and no model name,
// host, token count, prompt or stack trace reaches it, even when the state DB is full of them.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_KEYS, publicLeaks, publicLedger, scrubText } from "../dashboard/ledger-public";
import { FactoryState, type StageRunInput } from "../src/state";

const REPO = "acme/widgets";

function attempt(issue: number, over: Partial<StageRunInput> = {}): StageRunInput {
  return {
    repo: REPO,
    issue,
    stage: "build",
    agent: "claude",
    model: "claude-opus-5-5",
    started_at: "2026-10-01T00:00:00Z",
    finished_at: "2026-10-01T01:00:00Z",
    duration_ms: 3_600_000,
    tool_calls: 40,
    tokens_in: 812_345,
    tokens_out: 9_876,
    tokens_cached: 400_000,
    cost_usd: 2.4,
    exit_code: 0,
    killed_reason: "Error: spawn failed at run (/srv/worker/agent.ts:12:5)",
    session_id: "sess-1",
    ...over,
  };
}

function merged(state: FactoryState, issue: number, time: string, id = `merged-${issue}`): void {
  state.recordBusEvent({
    id,
    direction: "out",
    type: "factory.pr.merged",
    source: "factory@build-7.internal",
    subject: `${REPO}#${issue}`,
    time,
    data: JSON.stringify({ repo: REPO, issue, pr: 100 + issue, by: "factory", model: "gpt-6-luna" }),
    handled_at: null,
  });
}

// A state DB where every operator-detail column is filled, and the titles people wrote name models,
// hosts, token counts and a stack trace.
function seeded(): FactoryState {
  const state = new FactoryState(":memory:");
  const titles = [
    "Swap claude-opus-5-5 for nemotron-3.5-lightning in the docs",
    "Fix the deploy note for build-7.internal at 10.0.0.12:8080",
    "Explain the 812k tokens spike: TypeError: x is undefined at run (/srv/a.ts:3:9)",
    "Rewrite the onboarding guide",
  ];
  titles.forEach((title, i) => {
    state.upsertRun({ issue: i + 1, repo: REPO, title, stage: "pr", status: "shipped" });
    state.recordStageRun(attempt(i + 1));
    state.recordStageRun(attempt(i + 1, { stage: "verify", model: "gpt-6-luna", cost_usd: 0.9 }));
  });
  // Issue 4 has an attempt whose usage was never fully counted: its dollars are unknown, not zero.
  state.recordStageRun(attempt(4, { cost_usd: null, usage_complete: 0 }));
  // Issue 5 opened a PR that never merged, so it is not shipped.
  state.upsertRun({ issue: 5, repo: REPO, title: "Open but not merged", stage: "pr", status: "shipped" });
  for (let i = 1; i <= 4; i++) merged(state, i, `2026-10-0${i + 1}T12:00:00Z`);
  // The operator's merge of issue 1 lands a second event; it is still one shipped PR.
  merged(state, 1, "2026-10-09T12:00:00Z", "merged-1-operator");
  return state;
}

test("the public ledger lists every merged PR with title, repo, day, cycle time and whole dollars", () => {
  const ledger = publicLedger([seeded()], new Date("2026-10-26T09:00:00Z"));
  expect(ledger.generatedOn).toBe("2026-10-26");
  expect(ledger.shipped.map((e) => e.mergedOn)).toEqual(["2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02"]);
  for (const e of ledger.shipped) expect(Object.keys(e).sort()).toEqual([...ENTRY_KEYS].sort());
  const guide = ledger.shipped[0]!;
  expect(guide).toMatchObject({ title: "Rewrite the onboarding guide", repo: REPO, dollars: null });
  expect(ledger.shipped.at(-1)!.dollars).toBe(3);
  expect(ledger.shipped.some((e) => e.title === "Open but not merged")).toBe(false);
  expect(ledger.shipped.every((e) => e.cycleHours >= 0)).toBe(true);
});

test("no model name, host, token count, prompt or stack trace reaches the public ledger", () => {
  const ledger = publicLedger([seeded()]);
  expect(publicLeaks(ledger)).toEqual([]);
  const text = JSON.stringify(ledger);
  for (const leak of [
    "claude",
    "opus",
    "nemotron",
    "gpt",
    "build-7",
    ".internal",
    "10.0.0.12",
    "812",
    "tokens",
    "TypeError",
    "/srv/",
    "sess-1",
    "model",
    "cost_usd",
  ])
    expect(text.toLowerCase()).not.toContain(leak);
});

test("publicLeaks fails a ledger that carries a forbidden field or a model-like string", () => {
  const ok = { title: "Rewrite the guide", repo: REPO, mergedOn: "2026-10-02", cycleHours: 3, dollars: 2 };
  const doc = (e: object, extra: object = {}) => ({ generatedOn: "2026-10-26", shipped: [e], ...extra });
  expect(publicLeaks(doc(ok))).toEqual([]);
  for (const bad of [
    { ...ok, model: "x" },
    { ...ok, tokens_in: 5 },
    { ...ok, host: "a" },
    { ...ok, prompt: "You are a coding agent" },
    { ...ok, title: "Moved to claude-haiku-5-5" },
    { ...ok, title: "Retry gpt-6-luna" },
    { ...ok, title: "Ran on runner.local" },
    { ...ok, title: "Spent 40k tokens" },
    { ...ok, title: "Error: boom at f (/a.ts:1:2)" },
  ])
    expect(publicLeaks(doc(bad)).length, JSON.stringify(bad)).toBeGreaterThan(0);
  expect(publicLeaks(doc(ok, { worker_name: "w1" })).length).toBeGreaterThan(0);
  expect(scrubText("Use opus-5 on db.internal")).toBe("Use [redacted] on [redacted]");
});

test("the export script writes the ledger from a state DB and leaves no operator detail in the file", async () => {
  const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
  try {
    const db = join(home, "acme", "widgets");
    await Bun.$`mkdir -p ${db}`.quiet();
    const state = new FactoryState(join(db, "factory.db"));
    state.upsertRun({ issue: 1, repo: REPO, title: "Fix the sonnet typo on 10.1.2.3", stage: "pr", status: "shipped" });
    state.recordStageRun(attempt(1));
    merged(state, 1, "2026-10-02T00:00:00Z");
    state.close();
    const out = join(home, "shipped.json");
    const r = Bun.spawnSync(["bun", "scripts/ledger-public.ts", "--repo", REPO, "--out", out], {
      env: { ...process.env, FACTORY_HOME: home },
    });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const ledger = await Bun.file(out).json();
    expect(ledger.shipped).toHaveLength(1);
    expect(publicLeaks(ledger)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
