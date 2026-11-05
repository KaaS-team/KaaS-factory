// After a quota backoff ends, an issue a crash left in a running label is re-driven without a
// restart; an issue this process is working is not (#188).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { RateLimitError } from "../src/ports/scm";
import { FactoryState } from "../src/state";
import { recoverInFlight, startWatch } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, fixtureFor, MultiStageExecutor } from "./harness";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stale() {
  mkdirSync(tmpdir(), { recursive: true });
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, [LABEL.building])]);
  github.issues.get(1)!.comments = [
    {
      id: 1,
      author: "factory-bot",
      authorAssociation: "OWNER",
      body: `<!-- factory:data ${JSON.stringify({ stage: "plan", json: { risk: "low" } })} -->`,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const executor = new MultiStageExecutor();
  const files = {
    build: {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    },
    verify: {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    },
    pr: { "pr-body.md": "Did it.\nCloses #1" },
  } as const;
  for (const stage of ["build", "verify", "pr"] as const) executor.push(stage, 1, fixtureFor(stage, 1), files[stage]);
  const state = new FactoryState(":memory:");
  const deps = {
    github,
    git: new FakeGit(),
    state,
    executor,
    gateRunner: new FakeGateRunner(),
    cloneDir,
    workspacesDir,
  };
  const config = mergeConfig({ repo: "acme/widgets", pollIntervalSeconds: 3600 });
  return { github, state, deps, config };
}
const labels = (g: FakeGitHub) => g.issues.get(1)!.labels.map((l) => l.name);

describe("a stale running label after a quota backoff", () => {
  test("startWatch re-drives it once the backoff ends, without a restart", async () => {
    const { github, state, deps, config } = stale();
    github.rateLimited = new RateLimitError(429, (Date.now() + 100) / 1000);
    const stop = startWatch(deps as never, config, undefined, 10);
    try {
      await Bun.sleep(40);
      expect(labels(github)).toEqual([LABEL.building]);
      await Bun.sleep(120);
      state.recordDelivery({ id: "a", event: "issues", action: "labeled", repo: "acme/widgets" });
      await Bun.sleep(300);
      expect(labels(github)).toEqual([LABEL.inReview]);
    } finally {
      stop();
      state.close();
    }
  });

  test("an issue this process is working is not re-driven", async () => {
    const { github, state, deps, config } = stale();
    expect(await recoverInFlight(deps as never, config, new Set([1]))).toEqual([]);
    expect(labels(github)).toEqual([LABEL.building]);
    state.close();
  });
});
