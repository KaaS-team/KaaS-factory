import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { guardPlan } from "../src/plan-guard";

const config = mergeConfig({
  repo: "acme/widgets",
  agentCommands: { read: [], build: ["make *"], verify: ["make *"] },
});
const fixture = () => Bun.file(`${import.meta.dir}/fixtures/planned-issue.md`).text();
// The accepted fixture is 1020 bytes, so a valid body pads its Why section past the floor.
export const validBody = async () =>
  (await fixture()).replace("## Why\n", `## Why\n${"Resume work at the failed stage. ".repeat(30)}\n`);

describe("guardPlan", () => {
  test("a header-only plan fails and names every missing heading", () => {
    const g = guardPlan("<!-- factory:planned v1 -->\nMilestone: M1\n", config);
    expect(g.ok).toBe(false);
    const text = g.ok ? "" : g.reasons.join("\n");
    for (const h of ["Why", "Change", "Tests", "Acceptance", "Files"]) expect(text).toContain(`"## ${h}"`);
  });

  test("an 800-byte body fails on size", async () => {
    const stub = (await fixture()).slice(0, 800);
    const g = guardPlan(stub, config);
    expect(g.ok ? "" : g.reasons.join("\n")).toContain("bytes");
  });

  test("a valid plan passes", async () => {
    const body = await validBody();
    expect(Buffer.byteLength(body)).toBeGreaterThan(1500);
    expect(guardPlan(body, config)).toEqual({ ok: true });
  });
});
