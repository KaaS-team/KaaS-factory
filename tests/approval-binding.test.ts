// An approve names the plan digest it was asked for: it is refused once the plan is revised, a new
// commit lands, or the window passes, and one token is claimed once.

import { afterAll, describe, expect, test } from "bun:test";
import { APPROVAL_TTL_MS, bindingFields, planDigest, refuseApproval } from "../src/engine/approval-binding";
import { EventBus } from "../src/engine/bus";
import { resolveApproval } from "../src/engine/journal";
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
const planJson = (revision: number) => ({ risk: "high", revision, files: ["a"], autoApproveEligible: false });
const PLAN = (revision: number) => ({
  "plan-comment.md": `<!-- factory:plan v1 rev=${revision} -->\nplan`,
  "plan.json": JSON.stringify(planJson(revision)),
});

async function parked() {
  const parsed = parseWorkflowText(SHIP);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
  const e = engine(parsed.workflow, 0, {}, {}, { state, bus }, { outputs: { plan: [PLAN(1)] } });
  expect(await e.run()).toBe("awaiting-approval");
  const row = state.busEvents(100).find((r) => r.type === "factory.approval.requested")!;
  return { e, data: JSON.parse(row.data) as Record<string, unknown> };
}

describe("approval binding", () => {
  test("the digest ignores key order and the body stamp but not a revised plan", () => {
    expect(planDigest({ a: 1, b: 2, bodyHash: "x" })).toBe(planDigest({ b: 2, a: 1 }));
    expect(planDigest(planJson(1))).not.toBe(planDigest(planJson(2)));
  });

  test("the park records the digest of the plan and an expiry", async () => {
    const { data } = await parked();
    expect(data.planDigest).toBe(planDigest(planJson(1)));
    expect(typeof data.expiresAt).toBe("string");
    expect("headSha" in data).toBe(false);
  });

  test("an old approve is refused after the plan is revised", async () => {
    const { e, data } = await parked();
    const now = new Date();
    const refused = await resolveApproval(e.deps, e.config, String(data.token), "approve", "param", {
      plan: planJson(2),
      now,
    });
    expect(refused).toEqual({ error: "the plan changed since this approval was asked" });
    const ok = await resolveApproval(e.deps, e.config, String(data.token), "approve", "param", {
      plan: planJson(1),
      now,
    });
    expect(ok).toEqual({ issue: 1, step: "plan" });
  });

  test("a head sha, an expiry and a second claim each refuse", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const asked = bindingFields(planJson(1), "abc123", now);
    const held = refuseApproval(asked as never, { plan: planJson(1), headSha: "abc123", now });
    expect(held).toBe(undefined);
    expect(refuseApproval(asked as never, { headSha: "def456", now })).toBe(
      "a new commit landed since this approval was asked",
    );
    expect(refuseApproval(asked as never, { now: new Date(now.getTime() + APPROVAL_TTL_MS + 1) })).toBe(
      "that approval has expired",
    );
  });

  test("two approves of one token: only the first is claimed", async () => {
    const { e, data } = await parked();
    const args = [e.deps, e.config, String(data.token), "approve", "param"] as const;
    const both = await Promise.all([resolveApproval(...args), resolveApproval(...args)]);
    expect(both.filter((r) => "issue" in r)).toHaveLength(1);
    expect(both.filter((r) => "error" in r)).toEqual([{ error: "that approval is already resolved" }]);
  });
});
