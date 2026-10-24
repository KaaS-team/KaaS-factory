import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { StageName } from "../src/executor";
import { stageSettings } from "../src/stage-permissions";

const STAGES: StageName[] = ["triage", "plan", "build", "verify", "pr"];

describe("stageSettings", () => {
  for (const stage of STAGES) {
    test(`${stage}: valid JSON, may write only its own run dir (build also source), no deny key`, () => {
      const parsed = JSON.parse(stageSettings(stage, 15));
      const allow: string[] = parsed.permissions.allow;
      expect(allow).toContain("Edit(.factory/runs/issue-15/**)");
      expect(allow.includes("Edit(**)")).toBe(stage === "build");
      expect(parsed.permissions.deny).toBeUndefined();
      expect(allow.some((r) => /gh|push|merge/.test(r))).toBe(false);
    });
  }

  test("only verify may stash or checkout (revert-to-fail); no other stage can", () => {
    for (const stage of STAGES) {
      const allow: string[] = JSON.parse(stageSettings(stage, 1)).permissions.allow;
      expect(allow.includes("Bash(git checkout *)")).toBe(stage === "verify");
    }
  });

  // #42: verify runs a mutation on a copy through mutate.sh, never by editing the worktree.
  test("only verify may run mutate.sh, and verify still may not Edit the worktree", () => {
    for (const stage of STAGES) {
      const allow: string[] = JSON.parse(stageSettings(stage, 1)).permissions.allow;
      expect(allow.includes("Bash(.factory/mutate.sh *)")).toBe(stage === "verify");
      if (stage === "verify")
        expect(allow.filter((r) => r.startsWith("Edit("))).toEqual(["Edit(.factory/runs/issue-1/**)"]);
    }
  });
});

describe("repo-supplied agent commands", () => {
  const extra = { read: ["npm run lint"], build: ["npm test *"], verify: ["pytest *"] };

  test("no stage assumes bun or make without config", () => {
    for (const stage of STAGES) {
      const allow: string[] = JSON.parse(stageSettings(stage, 1)).permissions.allow;
      expect(allow.some((r) => /bun|make/.test(r))).toBe(false);
    }
  });

  test("read applies everywhere; build and verify grants stay in their own stage", () => {
    for (const stage of STAGES) {
      const allow: string[] = JSON.parse(stageSettings(stage, 1, extra)).permissions.allow;
      expect(allow.includes("Bash(npm run lint)")).toBe(true);
      expect(allow.includes("Bash(npm test *)")).toBe(stage === "build");
      expect(allow.includes("Bash(pytest *)")).toBe(stage === "verify");
    }
  });
});

// A command a skill tells the agent to run must be one its stage may run:
// under dontAsk a denied command fails the stage mid-run, where no unit test looks.
describe("skill commands are permitted by their stage", () => {
  const allowed = (allow: string[], cmd: string) =>
    allow.some((r) => {
      const m = /^Bash\((.*)\)$/.exec(r);
      if (!m) return false;
      const pat = m[1]!;
      return pat.endsWith("*") ? cmd.startsWith(pat.slice(0, -1)) : cmd === pat;
    });

  for (const stage of ["triage", "plan", "build", "verify", "pr"] as StageName[]) {
    test(`${stage}: every git or gates command in factory-${stage} is allowed`, () => {
      const text = readFileSync(`template/.claude/skills/factory-${stage}/SKILL.md`, "utf8");
      const allow: string[] = JSON.parse(stageSettings(stage, 1)).permissions.allow;
      const cmds = text
        .split("\n")
        .filter((l) => !/never|denies|the runner runs|gate_level/i.test(l))
        .flatMap((l) => [...l.matchAll(/`((?:git|bash|\.factory\/(?:gates|mutate)\.sh)[^`]*)`/g)].map((m) => m[1]!));
      for (const cmd of cmds) expect([cmd, allowed(allow, cmd)]).toEqual([cmd, true]);
    });
  }
});
