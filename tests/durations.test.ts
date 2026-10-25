import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatElapsed } from "../dashboard/public/lib/run-metrics.js";

test("the cockpit shows whole seconds, not milliseconds", () => {
  expect(formatElapsed(42_317)).toBe("42s");
  expect(formatElapsed(999)).toBe("999ms");
  expect(formatElapsed(61_400)).toBe("1m 1s");
  expect(formatElapsed(undefined as unknown as number)).toBe("Unavailable");
});

test("app.js formats every duration through formatElapsed", () => {
  expect(readFileSync("dashboard/public/app.js", "utf8")).not.toContain("formatDurationMillis");
});
