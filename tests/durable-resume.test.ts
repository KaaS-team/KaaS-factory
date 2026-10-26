// Durable resume: the event log is the run's journal. A rerun replays the steps it shows finished
// instead of running their agents again, and a park waits on a token an approval resolves.

import { afterAll, describe, expect, test } from "bun:test";
import { EventBus } from "../src/engine/bus";
import { resolveApproval } from "../src/engine/journal";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const SHIP = `---
name: ship
stages:
  triage: {}
  plan:
    needs: triage
    approval: on-risk:medium
  build:
    needs: plan
  verify:
    needs: build
  pr:
    needs: verify
---
`;

const PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "high", revision: 1, files: ["a"], autoApproveEligible: false }),
};

function setup(plans = 1) {
  const parsed = parseWorkflowText(SHIP);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
  return engine(parsed.workflow, 0, {}, {}, { state, bus }, { outputs: { plan: Array(plans).fill(PLAN) } });
}

const ran = (e: ReturnType<typeof setup>) => e.executor.pinned.map(([stage]) => stage);
const tokenOf = (e: ReturnType<typeof setup>) => {
  const row = e.deps.state.busEvents(100).find((r) => r.type === "factory.approval.requested");
  return (JSON.parse(row!.data) as { token: string }).token;
};

describe("durable resume", () => {
  test("an approved token resumes the run past the park without rerunning finished stages", async () => {
    const e = setup();
    expect(await e.run()).toBe("awaiting-approval");
    expect(ran(e)).toEqual(["triage", "plan"]);
    const resolved = await resolveApproval(e.deps, e.config, tokenOf(e), "approve", "param");
    expect(resolved).toEqual({ issue: 1, step: "plan" });
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.ready]);
    expect(await e.run()).toBe("shipped");
    expect(ran(e)).toEqual(["triage", "plan", "build", "verify", "pr"]);
  });

  test("a token resolves once, and an unknown one is refused", async () => {
    const e = setup();
    await e.run();
    const token = tokenOf(e);
    await resolveApproval(e.deps, e.config, token, "approve", "param");
    expect(await resolveApproval(e.deps, e.config, token, "approve", "param")).toEqual({
      error: "that approval is already resolved",
    });
    expect(await resolveApproval(e.deps, e.config, "nope", "approve", "param")).toEqual({
      error: "no approval waits on that token",
    });
  });

  test("a rerun with no approval keeps triage and asks again with a fresh plan and token", async () => {
    const e = setup(2);
    await e.run();
    await e.github.setStateLabel(e.config.repo, 1, [LABEL.awaitingApproval], LABEL.ready);
    const first = tokenOf(e);
    expect(await e.run()).toBe("awaiting-approval");
    expect(ran(e)).toEqual(["triage", "plan", "plan"]);
    const tokens = e.deps.state.busEvents(100).filter((r) => r.type === "factory.approval.requested");
    expect(tokens.map((r) => (JSON.parse(r.data) as { token: string }).token)).not.toEqual([first, first]);
  });
});
