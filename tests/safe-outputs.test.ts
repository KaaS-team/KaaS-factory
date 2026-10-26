// Safe outputs: agent stages only read and write files. Every stage's allow list, a repo's own
// agentCommands included, carries no rule that reaches GitHub, the tracker or the network, and the
// agent's env holds none of the runner's tokens. Only the runner's executor writes outward.

import { describe, expect, test } from "bun:test";
import { sanitizeEnv } from "../src/agents/env";
import type { StageName } from "../src/executor";
import { isOutward, refusal } from "../src/safe-outputs";
import { stageAllowRules } from "../src/stage-permissions";

const STAGES: StageName[] = ["triage", "plan", "build", "verify", "pr", "retro"];
// Each way a denylist was shown to be bypassed, as an agentCommands pattern.
const BYPASSES = [
  "gh pr create *",
  "git push *",
  "curl *",
  "git remote add *",
  "npm publish",
  "env gh pr create:*",
  "bash -c *",
  "git -c x=y push:*",
  "git --no-pager push *",
  "git --git-dir x push *",
  "/usr/bin/curl:*",
  "GH pr create *",
  "Git Push *",
  "xargs gh *",
  "python -c *",
  "python3.12 x.py",
  "npx some-cli *",
  "bunx some-cli *",
  "make * && gh pr create",
  "make $(gh pr create)",
  "GH_TOKEN=x make *",
  "git *",
  "m*ke test",
];
const TRIES = [...BYPASSES, "make test", "make:*", "cargo test *"];

describe("safe outputs", () => {
  test("no agent stage is allowed a command that writes to GitHub, the tracker or the network", () => {
    const extra = { read: TRIES, build: TRIES, verify: TRIES };
    for (const stage of STAGES) {
      const rules = stageAllowRules(stage, 7, extra);
      expect(rules.filter(isOutward)).toEqual([]);
      expect(rules).toContain("Bash(make test)");
      expect(rules).toContain("Bash(make:*)");
    }
  });

  test("every known bypass of an outward denylist is refused as an agentCommands pattern", () => {
    for (const p of BYPASSES) expect([p, refusal(p)]).toEqual([p, expect.any(String)]);
    for (const p of ["make test", "make *", "make:*", "cargo test *", "git diff *", "git log --oneline *"])
      expect([p, refusal(p)]).toEqual([p, undefined]);
  });

  test("the outward check knows each way out and leaves local git alone", () => {
    for (const cmd of ["gh issue comment 1", "git push origin x", "wget x", "ssh host"])
      expect(isOutward(`Bash(${cmd})`)).toBe(true);
    for (const rule of ["Bash(git commit *)", "Bash(git diff *)", "Edit(**)", "Bash(ghost)"])
      expect(isOutward(rule)).toBe(false);
    for (const stage of STAGES) expect(stageAllowRules(stage, 7).filter(isOutward)).toEqual([]);
  });

  test("an agent's env carries none of the runner's tokens", () => {
    const env = sanitizeEnv({ GH_TOKEN: "a", GITHUB_TOKEN: "b", FACTORY_LINEAR_TOKEN: "c", PATH: "/bin" }, []);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
