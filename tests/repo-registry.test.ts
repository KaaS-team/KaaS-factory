import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import { loadMachineConfig, MachineLeases, MachineSpend } from "../src/machine";
import { configForEntry, factoryRepo, registryProblems, servedRepos } from "../src/repo-registry";
import { pollRegistry } from "../src/registry-watch";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

mkdirSync(tmpdir(), { recursive: true });

function home(machine: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-registry-"));
  writeFileSync(join(dir, "machine.json"), JSON.stringify(machine));
  return dir;
}

describe("the registry in machine.json", () => {
  test("a fake repo is added by one entry and no code change", () => {
    const dir = home({ slots: 2, repos: [{ repo: "acme/factory", factory: true }, { repo: "acme/fake" }] });
    const { repos } = loadMachineConfig({ FACTORY_HOME: dir });
    expect(repos?.map((r) => r.repo)).toEqual(["acme/factory", "acme/fake"]);
    expect(factoryRepo(repos!)?.repo).toBe("acme/factory");
    expect(servedRepos(repos!).map((r) => r.repo)).toContain("acme/fake");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a bad entry stops the machine config from loading", () => {
    const dir = home({ slots: 2, repos: [{ repo: "nope" }] });
    expect(() => loadMachineConfig({ FACTORY_HOME: dir })).toThrow(/"repo" must be owner\/name/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("duplicates, unknown keys, bad caps and two factory repos are refused", () => {
    const where = "m.json";
    expect(registryProblems([{ repo: "a/b" }, { repo: "a/b" }], where).join()).toContain("listed twice");
    expect(registryProblems([{ repo: "a/b", color: 1 }], where).join()).toContain('unknown key "color"');
    expect(registryProblems([{ repo: "a/b", concurrency: 0 }], where).join()).toContain('"concurrency"');
    expect(
      registryProblems(
        [
          { repo: "a/b", factory: true },
          { repo: "a/c", factory: true },
        ],
        where,
      ).join(),
    ).toContain("only one repo");
    expect(registryProblems({}, where).join()).toContain("must be a list");
  });

  test("an entry's cap only lowers the repo's own concurrency", () => {
    expect(configForEntry({ repo: "a/b", concurrency: 1 }, { concurrency: 4 }).concurrency).toBe(1);
    expect(configForEntry({ repo: "a/b", concurrency: 9 }, { concurrency: 4 }).concurrency).toBe(4);
    expect(configForEntry({ repo: "a/b", pollIntervalSeconds: 60 }).pollIntervalSeconds).toBe(60);
  });
});

class TriageExecutor {
  readonly ran: string[] = [];
  constructor(private readonly repo: string) {}
  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.ran.push(`${this.repo}#${opts.issue}`);
    const dir = join(opts.cwd, runDir(opts.issue));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage-comment.md"), "<!-- factory:triage v1 -->\ntriage");
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify({
        disposition: "needs-info",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    );
    writeFileSync(join(dir, "question-comment.md"), "<!-- factory:question v1 -->\nWhich one?");
    return {
      events: [],
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      costReported: true,
      exitCode: 0,
      permissionDenials: [],
    };
  }
}

describe("one watcher serves every registered repo", () => {
  test("a fake registry of two repos dispatches one issue from each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-registry-"));
    const leases = new MachineLeases(join(dir, "machine.db"));
    const spend = new MachineSpend(join(dir, "machine.db"));
    const sources = new Map(
      ["acme/one", "acme/two"].map((repo) => {
        const executor = new TriageExecutor(repo);
        const deps = {
          github: new FakeGitHub([baseIssue(1, ["factory:ready"])]),
          git: new FakeGit(),
          state: new FactoryState(":memory:"),
          executor,
          gateRunner: new FakeGateRunner(),
          holdoutRunner: new FakeHoldoutRunner(),
          cloneDir: mkdtempSync(join(tmpdir(), "factory-clone-")),
          workspacesDir: mkdtempSync(join(tmpdir(), "factory-ws-")),
          machine: { leases, config: { slots: 2 }, spend },
        };
        return [repo, { deps, executor }] as const;
      }),
    );
    const registry = [{ repo: "acme/one" }, { repo: "acme/two" }, { repo: "acme/off", enabled: false }];
    const polled = await pollRegistry(registry, (e) => sources.get(e.repo)!);
    expect(Object.keys(polled)).toEqual(["acme/one", "acme/two"]);
    for (const [repo, { executor }] of sources) expect(executor.ran).toEqual([`${repo}#1`]);
    expect(leases.held()).toBe(0);
    leases.close();
    spend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a repo whose poll throws is reported and the others still run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-registry-"));
    const leases = new MachineLeases(join(dir, "machine.db"));
    const executor = new TriageExecutor("acme/good");
    const deps = {
      github: new FakeGitHub([baseIssue(1, ["factory:ready"])]),
      git: new FakeGit(),
      state: new FactoryState(":memory:"),
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: mkdtempSync(join(tmpdir(), "factory-clone-")),
      workspacesDir: mkdtempSync(join(tmpdir(), "factory-ws-")),
      machine: { leases, config: { slots: 2 }, spend: new MachineSpend(join(dir, "machine.db")) },
    };
    const polled = await pollRegistry([{ repo: "acme/bad" }, { repo: "acme/good" }], (e) => {
      if (e.repo === "acme/bad") throw new Error("no clone");
      return { deps };
    });
    expect(polled["acme/bad"]).toEqual({ error: "no clone" });
    expect(executor.ran).toEqual(["acme/good#1"]);
    leases.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("factory watch --all", () => {
  function setup(machine: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "factory-registry-"));
    writeFileSync(join(dir, "machine.json"), JSON.stringify(machine));
    return dir;
  }

  test("the CLI entry polls both repos of a fake registry and dispatches one issue from each", async () => {
    const dir = setup({
      slots: 2,
      repos: [{ repo: "acme/one" }, { repo: "acme/two" }, { repo: "acme/off", enabled: false }],
    });
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = dir;
    const leases = new MachineLeases(join(dir, "machine.db"));
    const spend = new MachineSpend(join(dir, "machine.db"));
    const executors = new Map<string, TriageExecutor>();
    const cloned: string[] = [];
    const cli = {
      args: ["watch", "--all", "--once"],
      flag: () => undefined,
      has: (n: string) => n === "once" || n === "all",
      resolveCloneDir: async () => "",
      watchDeps: async (cloneDir: string, config: { repo: string }) => {
        const executor = new TriageExecutor(config.repo);
        executors.set(config.repo, executor);
        return {
          github: new FakeGitHub([baseIssue(1, ["factory:ready"])]),
          git: new FakeGit(),
          state: new FactoryState(":memory:"),
          executor,
          gateRunner: new FakeGateRunner(),
          holdoutRunner: new FakeHoldoutRunner(),
          cloneDir,
          workspacesDir: mkdtempSync(join(tmpdir(), "factory-ws-")),
          machine: { leases, config: { slots: 2 }, spend },
        };
      },
    };
    const clone = async (repo: string) => {
      cloned.push(repo);
      const d = mkdtempSync(join(tmpdir(), "factory-clone-"));
      mkdirSync(join(d, ".factory"), { recursive: true });
      writeFileSync(join(d, ".factory", "config.json"), JSON.stringify({ repo }));
      return d;
    };
    const { cmdWatchRegistry } = await import("../src/registry-cli");
    try {
      await cmdWatchRegistry(cli as never, { cloneFor: clone, sleep: async () => {} });
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
    expect(cloned).toEqual(["acme/one", "acme/two"]);
    expect(executors.get("acme/one")?.ran).toEqual(["acme/one#1"]);
    expect(executors.get("acme/two")?.ran).toEqual(["acme/two#1"]);
    leases.close();
    spend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("factory watch --all with no registry refuses instead of watching nothing", () => {
    const dir = setup({ slots: 2 });
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "watch", "--all", "--once"], {
      env: { ...process.env, FACTORY_HOME: dir },
      timeout: 30_000,
    });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("lists no enabled repo");
    rmSync(dir, { recursive: true, force: true });
  });
});
