// Every event names what started the run, and a lapsed park window is stored as decision "timed".

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";
import { EventBus } from "../src/engine/bus";
import { readJournal, resolveApproval } from "../src/engine/journal";
import { approvalAudit, HANDOFF_MARKER, runOriginOf } from "../src/engine/run-origin";
import { cronMarker, eventMarker } from "../src/engine/triggers";
import { parseWorkflowText } from "../src/engine/workflows";
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

async function parked() {
  const parsed = parseWorkflowText(SHIP);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  mkdirSync(tmpdir(), { recursive: true });
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
  const e = engine(parsed.workflow, 0, {}, {}, { state, bus }, { outputs: { plan: [PLAN] } });
  expect(await e.run()).toBe("awaiting-approval");
  const row = state.busEvents(100).find((r) => r.type === "factory.approval.requested")!;
  return { e, state, workflow: parsed.workflow, token: String((JSON.parse(row.data) as { token: string }).token) };
}

describe("run origin", () => {
  test("a hidden marker names the schedule, handoff or watcher; none means a person", () => {
    expect(runOriginOf(`x\n${cronMarker("ship", 0)}`)).toBe("schedule");
    expect(runOriginOf(`${HANDOFF_MARKER} a->b -->`)).toBe("handoff");
    expect(runOriginOf(eventMarker("ship", "e1"))).toBe("watcher");
    expect(runOriginOf("plain issue")).toBe("person");
    expect(runOriginOf(null)).toBe("person");
  });

  test("the events of a run carry startedBy", async () => {
    const { state } = await parked();
    const rows = state.busEvents(100).filter((r) => r.type === "factory.approval.requested");
    expect((JSON.parse(rows[0]!.data) as { startedBy: string }).startedBy).toBe("person");
  });
});

describe("timed approval", () => {
  test("a timed resolve is stored as timed by the timer, resumes the run, and is not human", async () => {
    const { e, state, workflow, token } = await parked();
    const ok = await resolveApproval(e.deps, e.config, token, "timed", "param");
    expect(ok).toEqual({ issue: 1, step: "plan" });
    expect(readJournal(state, 1, workflow).approved.has("plan")).toBe(true);
    expect(approvalAudit(state.busEvents(100))).toEqual([{ token, decision: "timed", by: "timer", human: false }]);
  });

  test("a person's approve stays human", async () => {
    const { e, state, token } = await parked();
    await resolveApproval(e.deps, e.config, token, "approve", "param");
    expect(approvalAudit(state.busEvents(100))).toEqual([{ token, decision: "approve", by: "param", human: true }]);
  });
});
