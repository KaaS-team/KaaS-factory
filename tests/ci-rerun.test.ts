// rerun_failed_ci_jobs: only the followed run, never after a push, and it spends the red-CI loop cap.

import { describe, expect, test } from "bun:test";
import { decideRerun, RERUN_ACTION, RERUN_PROMPT, rerunFailedCiJobs, type FollowUpState } from "../src/ci-rerun";

const fresh: FollowUpState = { runId: 77, pushed: false, redLoops: 0 };
function port() {
  const calls: number[] = [];
  return { calls, rerunFailedJobs: async (id: number) => void calls.push(id) };
}

describe("rerunFailedCiJobs", () => {
  test("a follow-up with no commit reruns the followed run once", async () => {
    const p = port();
    const r = await rerunFailedCiJobs(fresh, 77, p);
    expect(r).toEqual({ ok: true, state: { runId: 77, pushed: false, redLoops: 1 } });
    expect(p.calls).toEqual([77]);
  });

  test("a follow-up that pushed a commit never reruns", async () => {
    const p = port();
    const r = await rerunFailedCiJobs({ ...fresh, pushed: true }, 77, p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("pushed-commit");
    expect(p.calls).toEqual([]);
  });

  test("another run is refused", async () => {
    const p = port();
    const r = await rerunFailedCiJobs(fresh, 78, p);
    expect(r.ok === false && r.reason).toBe("wrong-run");
    expect(p.calls).toEqual([]);
  });

  test("the cap stops after 2 red loops", async () => {
    const p = port();
    let s = fresh;
    for (let i = 0; i < 2; i++) {
      const r = await rerunFailedCiJobs(s, 77, p);
      expect(r.ok).toBe(true);
      s = r.state;
    }
    const third = await rerunFailedCiJobs(s, 77, p);
    expect(third.ok === false && third.reason).toBe("loop-cap");
    expect(p.calls).toEqual([77, 77]);
  });

  test("loops already spent by commits count toward the cap", () => {
    expect(decideRerun({ ...fresh, redLoops: 1 }, 77) === undefined).toBe(true);
    expect(decideRerun({ ...fresh, redLoops: 2 }, 77)).toBe("loop-cap");
  });
});

describe("prompt", () => {
  test("names the action and says a pushed commit reruns CI itself", () => {
    expect(RERUN_PROMPT).toContain(RERUN_ACTION);
    expect(RERUN_PROMPT).toContain("re-runs CI by itself");
  });
});
