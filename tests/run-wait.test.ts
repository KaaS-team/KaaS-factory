import { describe, expect, test } from "bun:test";
import { RunFollower, RunHistory, isBlocked, sendPrompt, waitForStatus } from "../src/run-wait";

const start = { status: "running", stage: "build" } as const;

describe("run wait", () => {
  test("a wait is answered by the event that reaches the status, not by polling", async () => {
    const h = new RunHistory(start);
    const waiting = waitForStatus(h, { until: "verifying", timeoutMs: 5000 });
    h.push({ stage: "verify" });
    h.push({ status: "verifying" });
    expect(await waiting).toEqual({
      result: "reached",
      snapshot: { seq: 2, view: { status: "verifying", stage: "verify" } },
    });
  });

  test("a wait that is already satisfied resolves at once", async () => {
    const h = new RunHistory({ status: "shipped", stage: "pr" });
    expect((await waitForStatus(h, { until: "shipped", timeoutMs: 5000 })).result).toBe("reached");
  });

  test("a wait times out with the current snapshot", async () => {
    const h = new RunHistory(start);
    const r = await waitForStatus(h, { until: "shipped", timeoutMs: 10 });
    expect(r).toEqual({ result: "timeout", snapshot: { seq: 0, view: { status: "running", stage: "build" } } });
  });

  test("history is bounded and a stale cursor is events_lost", () => {
    const h = new RunHistory(start, 3);
    for (let i = 0; i < 5; i++) h.push({ stage: "plan" });
    expect(h.since(0)).toEqual({ events_lost: true });
    expect(h.since(1)).toEqual({ events_lost: true });
    expect(h.since(2)).toEqual({
      events: [
        { seq: 3, patch: { stage: "plan" } },
        { seq: 4, patch: { stage: "plan" } },
        { seq: 5, patch: { stage: "plan" } },
      ],
    });
    expect(h.since(5)).toEqual({ events: [] });
    expect(h.since(9)).toEqual({ events_lost: true });
  });

  test("a wait with a lost cursor answers events_lost with the snapshot", async () => {
    const h = new RunHistory(start, 2);
    for (const stage of ["plan", "verify", "pr"] as const) h.push({ stage });
    expect(await waitForStatus(h, { until: "shipped", timeoutMs: 5000, cursor: 0 })).toEqual({
      result: "events_lost",
      snapshot: { seq: 3, view: { status: "running", stage: "pr" } },
    });
  });

  test("a slow client overruns the history, reconciles from the snapshot and matches a fast client", () => {
    const h = new RunHistory(start, 4);
    const fast = new RunFollower({ ...start }, 0);
    const slow = new RunFollower({ ...start }, 0);
    const stages = ["plan", "build", "verify", "pr"] as const;
    for (let i = 0; i < 20; i++) {
      h.push({ stage: stages[i % 4] });
      expect(fast.catchUp(h)).toBe(false);
    }
    h.push({ status: "needs-human" });
    expect(fast.catchUp(h)).toBe(false);

    expect(slow.catchUp(h)).toBe(true);
    expect(slow.view).toEqual(fast.view);
    expect(slow.cursor).toBe(fast.cursor);
    expect(slow.view).toEqual({ status: "needs-human", stage: "pr" });

    h.push({ status: "running" });
    expect(slow.catchUp(h)).toBe(false);
    expect(fast.catchUp(h)).toBe(false);
    expect(slow.view).toEqual(fast.view);
  });

  test("a prompt to a blocked run returns run_blocked and sends nothing", async () => {
    const h = new RunHistory({ status: "awaiting-approval", stage: "plan" });
    let sent = 0;
    const send = async () => {
      sent++;
    };
    expect(await sendPrompt(h, send)).toEqual({ sent: false, error: "run_blocked", status: "awaiting-approval" });
    expect(sent).toBe(0);
    h.push({ status: "running" });
    expect(await sendPrompt(h, send)).toEqual({ sent: true });
    expect(sent).toBe(1);
  });

  test("blocked statuses are exactly the ones waiting on a person", () => {
    expect(["needs-info", "awaiting-approval", "needs-human"].every((s) => isBlocked(s as never))).toBe(true);
    expect(
      ["running", "verifying", "rejected", "shipped", "failed", "cancelled"].some((s) => isBlocked(s as never)),
    ).toBe(false);
  });
});
