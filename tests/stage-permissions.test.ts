import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "../src/agents/presets/claude";
import type { StageName } from "../src/executor";
import { commandParts, projectPlugins, stageSettings, uncoveredPart } from "../src/stage-permissions";

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

describe("uncoveredPart", () => {
  test("splits a compound command outside quotes", () => {
    expect(commandParts(`git log --oneline -3 && echo "a; b" | wc -l || true\nls`)).toEqual([
      "git log --oneline -3",
      'echo "a; b"',
      "wc -l",
      "true",
      "ls",
    ]);
  });

  test("names the first part the allow list does not cover (#91)", () => {
    const allow = ["Bash(git status*)", "Bash(head *)", "Bash(ls)"];
    expect(uncoveredPart("git status --short; npm ls zod undici 2>&1 | head -20", allow)).toBe(
      "npm ls zod undici 2>&1",
    );
    expect(uncoveredPart("git status && ls", allow)).toBeUndefined();
    expect(uncoveredPart("ls -la", allow)).toBe("ls -la");
  });
});

// #88: kaas.team's .claude/settings.json turned on the operator's plugins, and one of their hooks refused every plan Write.
describe("project plugins stay out of a stage", () => {
  test("every plugin the repo turns on is turned off in the stage settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugins-"));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "guards@m": true, "off@m": false } }),
    );
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "local@m": true } }));
    expect(projectPlugins(dir)).toEqual(["guards@m", "local@m"]);
    const argv = claudeArgs({ stage: "plan", issue: 5, cwd: dir, maxBudgetUsd: 1 });
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.enabledPlugins).toEqual({ "guards@m": false, "local@m": false });
  });

  test("a repo with no settings file adds no enabledPlugins key", () => {
    expect(projectPlugins(mkdtempSync(join(tmpdir(), "plugins-")))).toEqual([]);
    expect(JSON.parse(stageSettings("plan", 1)).enabledPlugins).toBeUndefined();
  });
});
