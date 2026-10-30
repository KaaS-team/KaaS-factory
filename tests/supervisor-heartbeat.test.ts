// The heartbeat turns push time and session age into one plain sentence with the next step.
import { describe, expect, test } from "bun:test";
import { heartbeat, type SessionSnapshot } from "../src/supervisor/heartbeat";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MIN = 60_000;
const ago = (m: number) => new Date(NOW - m * MIN).toISOString();
const snap = (extra: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  issue: 324,
  branch: "factory/issue-324",
  startedAt: ago(5),
  ...extra,
});

describe("supervisor heartbeat", () => {
  test("5 minutes with no push is on track", () => {
    const r = heartbeat(snap(), NOW);
    expect(r.verdict).toBe("on-track");
    expect(r.sentence).toContain("no push is due yet");
  });

  test("21 minutes with no push is stale and says what to do", () => {
    const r = heartbeat(snap({ startedAt: ago(21) }), NOW);
    expect(r.verdict).toBe("stale");
    expect(r.sentence).toContain("21 minutes");
    expect(r.sentence).toContain("nudge it or stop it and relaunch");
  });

  test("21 minutes with a push at minute 8 is on track", () => {
    const r = heartbeat(snap({ startedAt: ago(21), lastPushAt: ago(13) }), NOW);
    expect(r.verdict).toBe("on-track");
    expect(r.sentence).toContain("13 minutes ago");
  });

  test("a pull request is finished and named", () => {
    const r = heartbeat(snap({ prNumber: 400, lastPushAt: ago(1) }), NOW);
    expect(r.verdict).toBe("finished");
    expect(r.sentence).toContain("#400");
    expect(r.sentence).toContain("review");
  });

  test("ended with a push but no pull request says open one", () => {
    const r = heartbeat(snap({ endedAt: ago(1), lastPushAt: ago(2) }), NOW);
    expect(r.verdict).toBe("finished");
    expect(r.sentence).toContain("open one from the branch");
  });

  test("ended with no push says relaunch", () => {
    const r = heartbeat(snap({ endedAt: ago(1) }), NOW);
    expect(r.verdict).toBe("finished");
    expect(r.sentence).toContain("relaunch");
  });

  test("an unreadable start time is stale, not a throw", () => {
    const r = heartbeat(snap({ startedAt: "yesterday-ish" }), NOW);
    expect(r.verdict).toBe("stale");
    expect(r.sentence).toContain("unreadable");
  });

  test("every sentence starts with the issue and branch", () => {
    const cases = [
      snap(),
      snap({ startedAt: ago(30) }),
      snap({ prNumber: 1 }),
      snap({ endedAt: ago(1) }),
      snap({ startedAt: "x" }),
    ];
    for (const c of cases) {
      expect(heartbeat(c, NOW).sentence.startsWith("Issue #324 (`factory/issue-324`)")).toBe(true);
    }
  });
});
