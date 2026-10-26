// Any coding agent runs the factory: the same ticket ships through a bare command, a preset CLI and the
// ACP seam, and through two unrelated ACP servers, with the same comments, labels and PR on the issue.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import type { AgentConfig } from "../src/agents/types";
import { configProblems, mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const scratch = mkdtempSync(join(tmpdir(), "factory-any-agent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = (f: string) => join(import.meta.dir, "fixtures/agents", f);
const bin = mkdtempSync(join(scratch, "bin-"));
symlinkSync(fixture("fake-codex.ts"), join(bin, "codex"));

class SkillGit extends FakeGit {
  override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number) {
    await super.ensureWorktree(cloneDir, worktreeDir, issue);
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(worktreeDir, ".claude/skills"), {
      recursive: true,
    });
  }
}

// One ticket, one agent: what the issue shows afterwards, with the agent's own name taken out.
async function ship(agent: AgentConfig) {
  const issue = { ...baseIssue(42, [LABEL.ready]), title: "Fix the rounding in totals" };
  const github = new FakeGitHub([issue]);
  const state = new FactoryState(":memory:");
  state.setToggle("auto_approve_low_risk", true);
  const config = mergeConfig({ repo: "acme/widgets", agents: { a: agent }, stages: { default: "a" } });
  expect(configProblems(config)).toEqual([]);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const result = await processReadyIssue(
      issue,
      {
        github,
        git: new SkillGit(),
        state,
        executor: new CommandExecutor(config.agents, config.stages),
        gateRunner: new FakeGateRunner(),
        holdoutRunner: new FakeHoldoutRunner(),
        cloneDir: mkdtempSync(join(scratch, "clone-")),
        workspacesDir: mkdtempSync(join(scratch, "ws-")),
      },
      config,
    );
    const stages = state.listStageRuns("acme/widgets").map((r) => r.stage);
    const after = await github.getIssue("acme/widgets", 42);
    state.close();
    return {
      result,
      stages,
      // What the agent wrote, up to the run stats: each agent reports its own time, tool calls and tokens.
      pr: github.createdPrs.map((p) => p.body.slice(0, p.body.indexOf("Closes #42") + 10)),
      labels: after.labels.map((l) => l.name).sort(),
      markers: after.comments.map((c) => /<!-- factory:(\w+)/.exec(c.body)?.[1]).filter(Boolean),
    };
  } finally {
    process.env.PATH = saved;
  }
}

describe("any agent", () => {
  test("the same ticket ships with a bare command, a preset CLI and an ACP server", async () => {
    const bare = await ship({ command: [fixture("fake-agent.sh")] });
    expect(bare.result).toBe("shipped");
    expect(bare.pr[0]).toContain("Closes #42");
    expect(bare.stages).toEqual(["triage", "plan", "build", "verify", "pr"]);
    expect(await ship({ preset: "codex", model: "gpt-5.6-terra" })).toEqual(bare);
    expect(await ship({ preset: "acp", command: [process.execPath, fixture("fake-acp.ts")] })).toEqual(bare);
  }, 30_000);

  test("one ACP seam: two unrelated ACP servers ship the same ticket the same way", async () => {
    const ts = await ship({ preset: "acp", command: [process.execPath, fixture("fake-acp.ts")] });
    const py = await ship({ preset: "acp", command: ["python3", fixture("fake-acp.py")] });
    expect(ts.result).toBe("shipped");
    expect(py).toEqual(ts);
  }, 30_000);
});
