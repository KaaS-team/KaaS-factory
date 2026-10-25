// Ported from owainlewis/machinist@3943516 internal/controlplane/web/src/catalog-copy.test.js:1-end (MIT, Copyright (c) 2026 Owain Lewis). Deviations: also covers worker-status.test.js:1-end; the checks read dashboard/public/app.js and the copy is the Agents page's, since a factory agent is a CLI on this machine rather than a registered worker.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "..", "..", "..", "dashboard", "public", "app.js"), "utf8");

test("agents use live status copy and an empty state that says what to do", () => {
  expect(app).toContain("Reading the factory's state.");
  expect(app).toContain("No agents configured");
  expect(app).toContain("Add one under agents in .factory/config.json.");
});

test("agents show verified and not-yet-verified status, and the stages each serves", () => {
  expect(app).toMatch(/r\.verified \? "Verified" : "Verified by participants: not yet"/);
  expect(app).toMatch(/r\.verified \? "ok" : "warn"/);
  expect(app).toMatch(/r\.stages\.length \? r\.stages\.join\(", "\) : "None"/);
});
