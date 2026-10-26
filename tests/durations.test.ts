import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { formatElapsed } from "../dashboard/public/lib/run-metrics.js";

test("the cockpit shows whole seconds, not milliseconds", () => {
  expect(formatElapsed(42_317)).toBe("42s");
  expect(formatElapsed(999)).toBe("999ms");
  expect(formatElapsed(61_400)).toBe("1m 1s");
  expect(formatElapsed(undefined as unknown as number)).toBe("Unavailable");
});

test("the page code formats every duration through formatElapsed", () => {
  const views = readdirSync("dashboard/public/lib").filter((f) => f.startsWith("view-"));
  expect(views.length).toBeGreaterThan(0);
  for (const f of ["app.js", ...views.map((v) => `lib/${v}`)])
    expect(readFileSync(`dashboard/public/${f}`, "utf8"), f).not.toContain("formatDurationMillis");
});
