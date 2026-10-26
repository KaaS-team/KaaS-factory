// Per-team back-pressure and an org cap (src/org-caps.ts): a team whose factory work already
// waits on people gets no new pickups, and the org cap holds every team once reached.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, mergeConfig } from "../src/config";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import type { StageName, StageRunOptions } from "../src/executor";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner, fixtureFor } from "./harness";

// Records each pickup and replays a real stage result, so every admitted dispatch completes.
class RecordingExecutor {
  readonly started = new Set<number>();
  async runStage(opts: StageRunOptions & { stage: StageName }) {
    this.started.add(opts.issue);
    return fixtureFor(opts.stage, opts.issue).runStage(opts);
  }
}

async function pickups(issues: ReturnType<typeof baseIssue>[], config: Parameters<typeof mergeConfig>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "factory-caps-"));
  const executor = new RecordingExecutor();
  const deps = {
    github: new FakeGitHub(structuredClone(issues)),
    git: new FakeGit(),
    state: new FactoryState(":memory:"),
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir: dir,
    workspacesDir: dir,
  };
  await pollOnce(deps, mergeConfig({ repo: "acme/repo", concurrency: 4, ...config }));
  rmSync(dir, { recursive: true, force: true });
  return [...executor.started].sort((a, b) => a - b);
}

describe("team and org caps", () => {
  test("a team at its cap of work waiting on people gets no new pickups, other teams do, and the org cap holds all", async () => {
    const issues = [
      baseIssue(1, ["factory:in-review", "team:pay"]),
      baseIssue(2, ["factory:awaiting-approval", "team:pay"]),
      baseIssue(3, ["factory:ready", "team:pay"]),
      baseIssue(4, ["factory:ready", "team:web"]),
      baseIssue(5, ["factory:ready", "team:web"]),
      baseIssue(6, ["factory:ready"]),
    ];
    const ready = (started: number[]) => started.filter((n) => n >= 3);
    // No caps (team profile): every ready issue is picked up.
    expect(ready(await pickups(issues, {}))).toEqual([3, 4, 5, 6]);
    // scaleup's perTeam 3: pay has 2 waiting, so it gets one more; web gets both.
    expect(ready(await pickups(issues, { profile: "scaleup" }))).toEqual([3, 4, 5, 6]);
    // enterprise's perTeam 2: pay is full, web fills to 2, the unlabelled issue only meets the org cap.
    expect(ready(await pickups(issues, { profile: "enterprise" }))).toEqual([4, 5, 6]);
    expect(ready(await pickups(issues, { caps: { perTeam: 2, teams: { web: 1 } } }))).toEqual([4, 6]);
    expect(ready(await pickups(issues, { caps: { org: 3 } }))).toEqual([3]);

    expect(configProblems({ repo: "a/b", caps: { perTeam: -1, teams: { web: 1.5 }, size: 1 } })).toEqual([
      "caps.size: unknown key (allowed: perTeam, teams, org)",
      "caps.perTeam: expected a whole number, 0 or more",
      "caps.teams.web: expected a whole number, 0 or more",
    ]);
  });
});
