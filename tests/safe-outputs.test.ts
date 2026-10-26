// Safe outputs: agent stages only read and write files. Every stage's allow list, a repo's own
// agentCommands included, carries no rule that reaches GitHub, the tracker or the network, and the
// agent's env holds none of the runner's tokens. Only the runner's executor writes outward.

import { describe, expect, test } from "bun:test";
import { sanitizeEnv } from "../src/agents/env";
import type { StageName } from "../src/executor";
import { isOutward } from "../src/safe-outputs";
import { stageAllowRules } from "../src/stage-permissions";

const STAGES: StageName[] = ["triage", "plan", "build", "verify", "pr", "retro"];
const TRIES = ["gh pr create *", "git push *", "curl *", "git remote add *", "npm publish", "make test"];

describe("safe outputs", () => {
  test("no agent stage is allowed a command that writes to GitHub, the tracker or the network", () => {
    const extra = { read: TRIES, build: TRIES, verify: TRIES };
    for (const stage of STAGES) {
      const rules = stageAllowRules(stage, 7, extra);
      expect(rules.filter(isOutward)).toEqual([]);
      expect(rules).toContain("Bash(make test)");
    }
  });

  test("the outward check knows each way out and leaves local git alone", () => {
    for (const cmd of ["gh issue comment 1", "git push origin x", "wget x", "ssh host", "bun publish"])
      expect(isOutward(`Bash(${cmd})`)).toBe(true);
    for (const rule of ["Bash(git commit *)", "Bash(git diff *)", "Edit(**)", "Bash(ghost)"])
      expect(isOutward(rule)).toBe(false);
  });

  test("an agent's env carries none of the runner's tokens", () => {
    const env = sanitizeEnv({ GH_TOKEN: "a", GITHUB_TOKEN: "b", FACTORY_LINEAR_TOKEN: "c", PATH: "/bin" }, []);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
