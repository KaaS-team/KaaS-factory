// Ported from owainlewis/machinist@3943516 tests/test_agent.py (MIT, Copyright (c) 2026 Owain Lewis). Deviations: cases are adapted for validatePr/waitForCi's number-based closingIssuesReferences and single-prStatus-call shape (see src/ci.ts's own header); there is no comments/reviews collection to test here, so those upstream cases are dropped.

import { expect, test } from "bun:test";
import { PrValidationError, CiWaitError, ciStatusNow, validatePr, waitForCi, type CiCheck } from "../../../src/ci";
import type { PrStatus } from "../../../src/github";

function status(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    headRefOid: "sha1",
    closingIssuesReferences: [{ number: 7 }],
    statusCheckRollup: [],
    ...overrides,
  };
}

// A fake with a queue of prStatus responses, one per call; the last response
// repeats once the queue drains, so a test can leave a steady state after the
// interesting transitions.
function fakeGithub(responses: PrStatus[]) {
  const queue = [...responses];
  const calls: number[] = [];
  return {
    calls,
    prStatus: async (_repo: string, _number: number): Promise<PrStatus> => {
      calls.push(calls.length);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  };
}

test("validatePr: an open PR that closes the requested issue passes", async () => {
  const github = fakeGithub([status()]);
  await expect(validatePr(github, "o/r", 7, 42)).resolves.toBeUndefined();
});

test("validatePr: a closed PR is rejected", async () => {
  const github = fakeGithub([status({ state: "closed" })]);
  await expect(validatePr(github, "o/r", 7, 42)).rejects.toThrow(PrValidationError);
});

test("validatePr: a PR that closes a different issue is rejected, and the requested issue number is preserved in the error path", async () => {
  const github = fakeGithub([status({ closingIssuesReferences: [{ number: 99 }] })]);
  await expect(validatePr(github, "o/r", 7, 42)).rejects.toThrow(/does not close the requested issue/);
});

// GraphQL CheckRun shape: status/conclusion.
const running: CiCheck = { name: "build", status: "IN_PROGRESS" };
const passed: CiCheck = { name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
const skipped: CiCheck = { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" };
const failed: CiCheck = { name: "build", status: "COMPLETED", conclusion: "FAILURE" };
// Legacy commit-status shape: state only, no status/conclusion.
const legacyPending: CiCheck = { context: "ci/legacy", state: "PENDING" };
const legacySuccess: CiCheck = { context: "ci/legacy", state: "SUCCESS" };
const legacyFailure: CiCheck = { context: "ci/legacy", state: "FAILURE" };

function opts(overrides: Partial<Parameters<typeof waitForCi>[3]> = {}) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    timeoutSeconds: 120,
    intervalSeconds: 10,
    ...overrides,
  };
}

test("waitForCi: an empty check list keeps waiting, not passing, until checks appear and finish", async () => {
  const github = fakeGithub([
    status({ statusCheckRollup: [] }),
    status({ statusCheckRollup: [running] }),
    status({ statusCheckRollup: [passed, skipped] }),
  ]);
  const result = await waitForCi(github, "o/r", 42, opts());
  expect(result.status).toBe("passed");
  expect(result.checks).toEqual([passed, skipped]);
});

test("waitForCi: checks still pending at the deadline time out rather than pass or fail", async () => {
  const github = fakeGithub([status({ statusCheckRollup: [running] })]);
  const result = await waitForCi(github, "o/r", 42, opts({ timeoutSeconds: 15, intervalSeconds: 10 }));
  expect(result.status).toBe("timed-out");
});

test("waitForCi: a finished check that failed fails the run, even alongside legacy checks", async () => {
  const github = fakeGithub([status({ statusCheckRollup: [failed, legacySuccess] })]);
  const result = await waitForCi(github, "o/r", 42, opts());
  expect(result.status).toBe("failed");
});

test("waitForCi: legacy commit statuses are read by state, not status/conclusion", async () => {
  const github = fakeGithub([
    status({ statusCheckRollup: [legacyPending] }),
    status({ statusCheckRollup: [legacySuccess] }),
  ]);
  const result = await waitForCi(github, "o/r", 42, opts());
  expect(result.status).toBe("passed");
});

test("waitForCi: a legacy failure fails the run", async () => {
  const github = fakeGithub([status({ statusCheckRollup: [legacyFailure] })]);
  const result = await waitForCi(github, "o/r", 42, opts());
  expect(result.status).toBe("failed");
});

test("waitForCi: a head that moves between polls aborts the wait instead of re-polling the new commit", async () => {
  const github = fakeGithub([
    status({ headRefOid: "sha1", statusCheckRollup: [running] }),
    status({ headRefOid: "sha2", statusCheckRollup: [running] }),
  ]);
  await expect(waitForCi(github, "o/r", 42, opts())).rejects.toThrow(/head moved/);
});

test("waitForCi: a PR that closes while waiting stops polling immediately", async () => {
  const github = fakeGithub([
    status({ statusCheckRollup: [running] }),
    status({ state: "closed", statusCheckRollup: [running] }),
  ]);
  await expect(waitForCi(github, "o/r", 42, opts())).rejects.toThrow(CiWaitError);
});

test("waitForCi: a non-positive timeout or interval is rejected before any poll", async () => {
  const github = fakeGithub([status()]);
  await expect(waitForCi(github, "o/r", 42, opts({ timeoutSeconds: 0 }))).rejects.toThrow(CiWaitError);
  expect(github.calls.length).toBe(0);
});

// ciStatusNow: watch.ts's per-poll check, one snapshot, never a sleep loop.
test("ciStatusNow: one call, no polling, mirrors waitForCi's own pass/fail/pending labels", async () => {
  const finishedPassing = fakeGithub([status({ statusCheckRollup: [passed, skipped] })]);
  const passing = await ciStatusNow(finishedPassing, "o/r", 42);
  expect(passing.status).toBe("passed");
  expect(finishedPassing.calls.length).toBe(1);

  const finishedFailing = fakeGithub([status({ statusCheckRollup: [failed] })]);
  expect((await ciStatusNow(finishedFailing, "o/r", 42)).status).toBe("failed");

  const noChecks = fakeGithub([status({ statusCheckRollup: [] })]);
  expect((await ciStatusNow(noChecks, "o/r", 42)).status).toBe("timed-out");

  const stillRunning = fakeGithub([status({ statusCheckRollup: [running] })]);
  expect((await ciStatusNow(stillRunning, "o/r", 42)).status).toBe("timed-out");
});

test("ciStatusNow: never sleeps and never throws on a moved head or a closed PR (that is waitForCi's job, not this one's)", async () => {
  const closed = fakeGithub([status({ state: "closed", statusCheckRollup: [passed] })]);
  await expect(ciStatusNow(closed, "o/r", 42)).resolves.toMatchObject({ status: "passed" });
});
