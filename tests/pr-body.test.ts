import { describe, expect, test } from "bun:test";
import { renderPlanAcceptance } from "../src/acceptance";
import { prBody, renderWhatChanged } from "../src/engine/pr-body";
import { buildStatement, envelopeFromBody, renderReceipt, unsignedEnvelope } from "../src/receipt";
import type { StageRun } from "../src/state";
import { visibleLeaks } from "./harness";

const LONG = `${"The monthly plan page shows its price, the currency and the renewal date to every signed-in user. ".repeat(3)}End.`;
const plan = { goal: "Monthly plan shows its price.", criteria: [{ id: "AC-1", text: LONG }] };
const proof = { status: "bites" as const, reverted: ["src/a.ts"], tests: ["tests/a.test.ts"], cmd: "x", tail: "" };
const run = (stage: string, model: string): StageRun =>
  ({
    stage,
    agent: "claude",
    model,
    duration_ms: 5000,
    tool_calls: 4,
    cost_usd: 1.23,
    exit_code: 0,
    killed_reason: null,
    verdict: null,
  }) as unknown as StageRun;
const runs = [run("build", "claude-opus-5-5"), run("verify", "gpt-5")];

function receipt(criteria = 1): string {
  const statement = buildStatement({
    repo: "o/r",
    issue: 7,
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    at: "2026-01-01T00:00:00Z",
    acceptance: {
      base: "origin/main",
      errors: [],
      acs: Array.from({ length: criteria }, () => ({
        spec: "s",
        ac: "AC-1",
        text: "t",
        holdout: ["h"],
        new: true,
        base: "fail" as const,
        head: "pass" as const,
        ok: true,
      })),
    },
    holdout: { ok: true },
    holdoutRequired: true,
    proof,
    runs,
    files: { "proof.json": "{}" },
    operatorDetail: true,
  });
  return renderReceipt(unsignedEnvelope(statement));
}

function finishedBody(): string {
  return prBody("Why: users could not see the price.\n\nCloses #7", {
    whatChanged: renderWhatChanged(plan.goal, ["src/a.ts"], proof),
    acceptance: renderPlanAcceptance(plan, [{ id: "AC-1", status: "pass" }], undefined),
    runDetails: true,
  });
}

describe("a PR body built from a finished run", () => {
  test("pr body has no duplicated section", () => {
    const headings = finishedBody()
      .split("\n")
      .filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## What changed", "## Acceptance"]);
  });

  test("pr body keeps every criterion whole", () => {
    expect(LONG.length).toBeGreaterThan(200);
    expect(finishedBody()).toContain(`AC-1: ${LONG.replace(/\s+/g, " ")} | pass |`);
  });

  test("pr body carries no operator detail", () => {
    const body = finishedBody();
    expect(body).not.toMatch(/\$|claude-|gpt-|gemini-|tokens?\b|## Factory run/);
  });

  test("pr body carries no attestation blob", () => {
    const body = finishedBody();
    expect(body).not.toMatch(/[A-Za-z0-9+/=]{40,}/);
    expect(body).not.toContain("Envelope for kaas-verify");
    expect(body).toContain("run-details comment on the issue");
  });
});

describe("the run-details comment", () => {
  test("run details comment holds the receipt envelope", () => {
    const comment = receipt();
    expect(envelopeFromBody(comment)?.payloadType).toBe("application/vnd.in-toto+json");
    expect(comment).not.toContain("## Factory run");
    expect(visibleLeaks(comment.replace(/```json\n.+\n```/, ""))).toEqual([]);
  });

  test("receipt never contradicts the criteria table", () => {
    const text = receipt(0);
    expect(text).not.toContain("0 of 0");
    expect(text).toContain("the acceptance table is the record");
    expect(receipt(1)).toContain("Proven: 1 of 1 criteria.");
  });
});
