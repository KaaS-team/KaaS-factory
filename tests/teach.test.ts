// `factory teach` runs one agent in a fresh clone that can read the repo, its CI and the brain, then
// opens one PR with the workflows, minions and skills it answered, each checked before the PR.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { EventBus } from "../src/engine/bus";
import type { StageRunOptions, StageRunResult } from "../src/ports/agent";
import { FactoryState } from "../src/state";
import { runTeach } from "../src/teach";
import { FakeGit, FakeGitHub } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });

function repo(): string {
  const d = tmp("teach-repo-");
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  writeFileSync(join(d, ".github", "workflows", "ci.yml"), "jobs: { test: { steps: [{ run: make test }] } }\n");
  mkdirSync(join(d, ".factory"), { recursive: true });
  writeFileSync(join(d, ".factory", "mcp.json"), JSON.stringify({ mcpServers: { brain: { command: "brain-mcp" } } }));
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  return d;
}

const SHIP =
  "---\nname: ship\nstages:\n  triage: {}\n  build:\n    needs: triage\n    gates: [unit]\n  pr:\n    needs: build\n---\nEvery change ships after make test.\n";
const SKILL = "---\nname: release-check\ndescription: Checks the release notes before a PR.\n---\nRead CHANGELOG.md.\n";

class TeachingAgent {
  runs: StageRunOptions[] = [];
  ciSeen: boolean[] = [];
  constructor(private readonly files: Record<string, string>) {}
  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.runs.push(opts);
    this.ciSeen.push(existsSync(join(opts.cwd, ".github", "workflows", "ci.yml")));
    return {
      events: [],
      toolCalls: 3,
      tokensIn: 10,
      tokensOut: 10,
      costUsd: 0.1,
      exitCode: 0,
      permissionDenials: [],
      finalMessage: JSON.stringify({ files: this.files, summary: "Ship after make test." }),
      agent: "claude",
    };
  }
}

function deps(agent: TeachingAgent) {
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/o/r", autoDeliver: false, log: () => {} });
  const github = new FakeGitHub([]);
  const g = new FakeGit();
  const cloneDir = repo();
  return { executor: agent, state, bus, cloneDir, workspacesDir: tmp("teach-ws-"), github, git: g } as const;
}

const config = mergeConfig({ repo: "o/r" });

describe("factory teach", () => {
  test("teach reads the repo, its CI and the brain, and opens one PR with checked workflows and skills", async () => {
    const agent = new TeachingAgent({
      ".factory/workflows/ship.md": SHIP,
      ".claude/skills/release-check/SKILL.md": SKILL,
    });
    const d = deps(agent);
    const out = await runTeach(d as never, config, "We ship after make test passes and the release notes are checked.");
    expect(out).toMatchObject({ files: [".factory/workflows/ship.md", ".claude/skills/release-check/SKILL.md"] });
    expect(agent.ciSeen).toEqual([true]);
    expect(agent.runs[0]!.prompt).toContain("ci.yml");
    expect(agent.runs[0]!.prompt).toContain("release notes are checked");
    expect(Object.keys(agent.runs[0]!.mcp ?? {})).toEqual(["brain"]);
    expect(d.github.createdPrs).toHaveLength(1);
    expect(d.github.createdPrs[0]!.head).toMatch(/^factory\/teach-[0-9a-f]{8}$/);
    const ws = join(d.workspacesDir, d.github.createdPrs[0]!.head.replace(/\//g, "-"));
    expect(readFileSync(join(ws, ".factory/workflows/ship.md"), "utf8")).toBe(SHIP);
    expect(existsSync(join(d.cloneDir, ".factory/workflows/ship.md"))).toBe(false);
  });

  test("a taught file that would not load, or lands outside workflows, minions and skills, opens no PR", async () => {
    const agent = new TeachingAgent({
      ".factory/workflows/ship.md": SHIP.replace("needs: triage", "needs: nowhere"),
      ".factory/minions/nightly.yml": "name: nightly\n",
      ".claude/skills/x/SKILL.md": "no frontmatter",
      ".github/workflows/ci.yml": "jobs: {}",
    });
    const d = deps(agent);
    const out = await runTeach(d as never, config, "ship it");
    const problems = "problems" in out ? out.problems : [];
    expect(problems).toContain(".github/workflows/ci.yml: not a workflow, minion or skill");
    expect(problems).toContain('.factory/workflows/ship.md: stages.build.needs: no stage "nowhere"');
    expect(problems.some((p) => p.startsWith(".factory/minions/nightly.yml: "))).toBe(true);
    expect(problems).toContain(".claude/skills/x/SKILL.md: frontmatter needs name: x and a description");
    expect(d.github.createdPrs).toHaveLength(0);
  });
});
