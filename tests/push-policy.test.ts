import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems } from "../src/config";
import { installTemplate } from "../src/install-template";
import { defaultWorkflow } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
};
const make = (config: Record<string, unknown>) =>
  engine(defaultWorkflow(), 0, {}, {}, {}, { config, outputs: { plan: [PLAN] } });

describe("policy.push", () => {
  test("the runner pushes by default", async () => {
    const e = make({});
    await e.run();
    expect(e.git.pushed.length).toBeGreaterThan(0);
  });
  test("policy.push agent: the runner never pushes", async () => {
    const e = make({ policy: { push: "agent" } });
    await e.run();
    expect(e.git.pushed).toEqual([]);
  });
  test("a bad value is refused", () => {
    expect(configProblems({ repo: "a/b", policy: { push: "both" } }).join()).toContain("policy.push");
  });
});

describe("template settings follow policy.push", () => {
  const deny = (dir: string): string[] =>
    JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).permissions.deny;
  const fresh = () => {
    mkdirSync(tmpdir(), { recursive: true });
    return mkdtempSync(join(tmpdir(), "push-policy-"));
  };
  test("runner (default) denies git push", () => {
    const d = fresh();
    installTemplate(d, {});
    expect(deny(d)).toContain("Bash(git push*)");
    rmSync(d, { recursive: true, force: true });
  });
  test("agent drops the plain deny and keeps the force denies", () => {
    const d = fresh();
    installTemplate(d, { push: "agent" });
    expect(deny(d)).not.toContain("Bash(git push*)");
    expect(deny(d)).toContain("Bash(git push --force*)");
    rmSync(d, { recursive: true, force: true });
  });
});
