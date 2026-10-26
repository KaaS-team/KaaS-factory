// Agent steps off the factory's own process: with a docker `agentRuntime`, triage, plan, build,
// verify and pr each run in a container, keys passed by name only, and the ticket ships the same.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerSpec } from "../src/adapters/docker/execution";
import { CommandExecutor } from "../src/agents/executor";
import { mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { agentVm, loadMachineConfig } from "../src/machine";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const scratch = mkdtempSync(join(tmpdir(), "factory-remote-agent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bin = mkdtempSync(join(scratch, "bin-"));
symlinkSync(join(import.meta.dir, "fixtures/agents/fake-codex.ts"), join(bin, "codex"));

class SkillGit extends FakeGit {
  override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number) {
    await super.ensureWorktree(cloneDir, worktreeDir, issue);
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(worktreeDir, ".claude/skills"), {
      recursive: true,
    });
  }
}
const spec: DockerSpec = { kind: "docker", image: "ghcr.io/acme/agents:1", network: "bridge" };

function machine(runtimes: Record<string, unknown>) {
  const home = mkdtempSync(join(scratch, "home-"));
  writeFileSync(join(home, "machine.json"), JSON.stringify({ slots: 1, agentRuntime: "agents", runtimes }));
  return () => loadMachineConfig({ FACTORY_HOME: home });
}

describe("remote agent steps", () => {
  test("every agent step runs in the docker agentRuntime, and the ticket still ships", async () => {
    expect(agentVm(machine({ agents: spec })())).toEqual(spec);
    expect(machine({ agents: { kind: "docker", image: "x" } })).toThrow('needs a "network"');
    expect(machine({ agents: { kind: "ssh", host: "h", dir: "/w" } })).toThrow("microsandbox or docker runtime");

    const argvFile = join(scratch, "docker-argv");
    const saved = { PATH: process.env.PATH, DOCKER_ARGV_FILE: process.env.DOCKER_ARGV_FILE };
    process.env.PATH = `${join(import.meta.dir, "fixtures", "runtimes")}:${bin}:${saved.PATH}`;
    process.env.DOCKER_ARGV_FILE = argvFile;
    const issue = { ...baseIssue(42, [LABEL.ready]), title: "Fix the rounding in totals" };
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { a: { preset: "codex", model: "gpt-5.6-terra" } },
      stages: { default: "a" },
    });
    try {
      const result = await processReadyIssue(
        issue,
        {
          github,
          git: new SkillGit(),
          state,
          executor: new CommandExecutor(config.agents, config.stages, {}, undefined, spec),
          gateRunner: new FakeGateRunner(),
          holdoutRunner: new FakeHoldoutRunner(),
          cloneDir: mkdtempSync(join(scratch, "clone-")),
          workspacesDir: mkdtempSync(join(scratch, "ws-")),
        },
        config,
      );
      expect(result).toBe("shipped");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.DOCKER_ARGV_FILE === undefined) delete process.env.DOCKER_ARGV_FILE;
      else process.env.DOCKER_ARGV_FILE = saved.DOCKER_ARGV_FILE;
    }
    const runs = readFileSync(argvFile, "utf8")
      .split("---\n")
      .filter(Boolean)
      .map((r) => r.trim().split("\n"));
    const stageOf = (argv: string[]) => argv.find((a) => a.startsWith("FACTORY_STAGE="))?.slice(14);
    expect(runs.map(stageOf)).toEqual(state.listStageRuns("acme/widgets").map((r) => r.stage));
    expect(runs.map(stageOf)).toEqual(["triage", "plan", "build", "verify", "pr"]);
    for (const argv of runs) {
      expect(argv).toContain("ghcr.io/acme/agents:1");
      expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
      // The key goes by name: docker reads its value from its own env, never from argv.
      expect(argv[argv.indexOf("OPENAI_API_KEY") - 1]).toBe("-e");
      expect(argv.some((a) => a.startsWith("OPENAI_API_KEY="))).toBe(false);
    }
    state.close();
  });
});
