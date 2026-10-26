// The default harness: a repo with no .claude config still runs every stage on the factory's own
// skills and subagents, and a skill or subagent the repo configures wins over the default.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { renderPrompt } from "../src/agents/prompt";
import { mergeConfig } from "../src/config";
import { defaultSkills, defaultSubagents, provideDefaults, resolveSkill } from "../src/harness-defaults";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const scratch = mkdtempSync(join(tmpdir(), "factory-defaults-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const dir = (p: string) => mkdtempSync(join(scratch, p));
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdout: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
const write = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: the repo's own\n---\n${body}\n`;

describe("default harness", () => {
  test("a repo with no .claude config ships an issue on the factory's default skills and subagents", async () => {
    const workspacesDir = dir("ws-");
    const log = dir("log-");
    process.env.FAKE_AGENT_LOG = log;
    const issue = baseIssue(1, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { scripted: { command: [join(import.meta.dir, "fixtures/agents/fake-agent.sh")] } },
      stages: { default: "scripted" },
    });
    const deps = {
      ...{ github, git: new FakeGit(), state, executor: new CommandExecutor(config.agents, config.stages) },
      ...{ gateRunner: new FakeGateRunner(), holdoutRunner: new FakeHoldoutRunner(), cloneDir: dir("clone-") },
      workspacesDir,
    };
    try {
      expect(await processReadyIssue(issue, deps, config)).toBe("shipped");
    } finally {
      delete process.env.FAKE_AGENT_LOG;
    }
    const plan = readFileSync(join(import.meta.dir, "../template/.claude/skills/factory-plan/SKILL.md"), "utf8");
    expect(readFileSync(join(log, "plan.prompt"), "utf8")).toContain(plan.split("\n---\n")[1]!.trim().slice(0, 120));
    const worktree = join(workspacesDir, "issue-1");
    expect(defaultSkills()).toContain("factory-build");
    for (const s of defaultSkills()) expect(existsSync(join(worktree, ".claude/skills", s, "SKILL.md"))).toBe(true);
    expect(defaultSubagents()).toEqual(["factory-reviewer"]);
    expect(existsSync(join(worktree, ".claude/agents/factory-reviewer.md"))).toBe(true);
    state.close();
  });

  test("the defaults land where the agent reads skills, and git never sees them", () => {
    const repo = dir("repo-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, "README.md", "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const provided = provideDefaults(repo, ".codex/skills");
    expect(provided).toContain(".codex/skills/factory-plan/");
    expect(existsSync(join(repo, ".codex/skills/factory-plan/SKILL.md"))).toBe(true);
    expect(git(repo, "status", "--porcelain").stdout.toString()).toBe("");
    expect(provideDefaults(repo, ".codex/skills")).toEqual([]);
  });

  test("a skill or subagent the repo configures in .claude or .agents wins over the default", async () => {
    const repo = dir("own-");
    write(repo, ".claude/skills/factory-plan/SKILL.md", SKILL("factory-plan", "OUR PLAN RULES"));
    write(repo, ".agents/skills/factory-build/SKILL.md", SKILL("factory-build", "OUR BUILD RULES"));
    write(repo, ".claude/agents/factory-reviewer.md", "OUR REVIEWER");
    const provided = provideDefaults(repo);
    expect(provided).not.toContain(".claude/skills/factory-plan/");
    expect(provided).toContain(".claude/skills/factory-build/");
    expect(provided).not.toContain(".claude/agents/factory-reviewer.md");
    expect(provided).toContain(".claude/skills/factory-verify/");
    expect(readFileSync(join(repo, ".claude/skills/factory-plan/SKILL.md"), "utf8")).toContain("OUR PLAN RULES");
    // Claude reads only .claude/skills, so the repo's .agents copy is put there, not the default.
    expect(readFileSync(join(repo, ".claude/skills/factory-build/SKILL.md"), "utf8")).toContain("OUR BUILD RULES");
    expect(readFileSync(join(repo, ".claude/agents/factory-reviewer.md"), "utf8")).toBe("OUR REVIEWER");
    const prompt = (stage: "plan" | "build") => renderPrompt({ stage, issue: 1, cwd: repo, maxBudgetUsd: 1 });
    expect(await prompt("plan")).toContain("OUR PLAN RULES");
    expect(await prompt("build")).toContain("OUR BUILD RULES");
    expect(resolveSkill(dir("agents-only-"), "factory-build")?.source).toBe("default");
    const agentsOnly = dir("agents-only-");
    write(agentsOnly, ".agents/skills/factory-build/SKILL.md", SKILL("factory-build", "x"));
    expect(resolveSkill(agentsOnly, "factory-build")).toEqual({
      path: join(agentsOnly, ".agents/skills/factory-build/SKILL.md"),
      source: "repo",
    });
  });
});
