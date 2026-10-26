import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analytics } from "../dashboard/analytics";
import { execSummary } from "../dashboard/public/lib/exec-summary.js";
import type { Run } from "../src/state";

const now = Date.parse("2026-10-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const run = (status: string, started: number, updated: number) =>
  ({ status, started_at: hoursAgo(started), updated_at: hoursAgo(updated) }) as Run;

describe("inbox brief", () => {
  test("the week counts runs started, and runs shipped or failed by their last update", () => {
    const runs = [
      run("shipped", 30, 20),
      run("shipped", 400, 300), // ended before the week
      run("failed", 400, 100),
      run("running", 2, 1),
      run("needs-human", 10, 5),
    ];
    expect(analytics(runs, [], new Date(now)).week).toEqual({ started: 3, shipped: 1, failed: 1 });
  });

  test("it says the week, what waits and for how long, and the spend", () => {
    const a = { week: { started: 3, shipped: 1, failed: 1 }, spend7dUsd: 2.5 };
    const items = [{ waitingSince: hoursAgo(5) }, { waitingSince: hoursAgo(50) }];
    expect(execSummary(a, items, now)).toBe(
      "This week 3 runs started, 1 shipped and 1 failed. 2 items wait on you; the oldest for 2 days. $2.50 spent in the last 7 days.",
    );
    expect(execSummary(a, [{ waitingSince: hoursAgo(1) }], now)).toContain("One item waits on you, for 1 hour.");
  });

  test("a quiet week and an empty inbox say so, with no spend line", () => {
    const a = { week: { started: 0, shipped: 0, failed: 0 }, spend7dUsd: 0 };
    expect(execSummary(a, [], now)).toBe("No runs this week. Nothing waits on you.");
  });

  test("before analytics loads it still says what waits", () => {
    expect(execSummary(undefined, [{ waitingSince: hoursAgo(0) }], now)).toBe(
      "One item waits on you, for under an hour.",
    );
  });

  test("the inbox loads analytics and leads with the brief", () => {
    const app = ["app.js", "lib/view-inbox.js"].map((f) => readFileSync(`dashboard/public/${f}`, "utf8")).join("\n");
    expect(app).toContain('inbox: ["analytics", "/api/analytics"]');
    expect(app).toContain('heading("Inbox", execSummary(analytics, items))');
  });
});
