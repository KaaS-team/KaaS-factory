// Every adapter directory registers here and runs its port's contract suite,
// so a new runtime or SCM can't land without proving it behaves like the rest.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "bun:test";
import { DockerExecution } from "../src/adapters/docker/execution";
import { GitLeases } from "../src/adapters/git-lease/lease";
import { GitHubSpend } from "../src/adapters/github-store/spend";
import { HttpSandboxExecution } from "../src/adapters/http-sandbox/execution";
import { LocalExecution } from "../src/adapters/local/execution";
import { LwprExecution } from "../src/adapters/lwpr/execution";
import { PoolExecution, SqliteUsageStore } from "../src/adapters/pool/execution";
import { SshExecution } from "../src/adapters/ssh/execution";
import { WrapExecution } from "../src/adapters/wrap/execution";
import { startSandbox } from "./fixtures/http-sandbox";
import type { ExecResult, ExecutionPort } from "../src/ports/execution";
import { executionContract } from "./ports/execution.contract";
import { leaseContract } from "./ports/lease.contract";
import { spendContract } from "./ports/spend.contract";
import { baseIssue, FakeGitHub, FakeLeases } from "./harness";

// A fake that obeys the contract by running through bash too: what a test
// double of a remote runtime looks like when it is held to the same suite.
class RecordingExecution implements ExecutionPort {
  readonly ran: string[] = [];
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    this.ran.push(cmd);
    return new LocalExecution().run(cmd, cwd);
  }
}

// Remote runtimes run their real argv against stand-ins on PATH (tests/fixtures/runtimes), which
// behave like the real tools where it matters: lwpr merges streams and runs on a copy.
function onFakePath(run: () => void): () => void {
  return () =>
    describe("with stand-in tools", () => {
      const saved = process.env.PATH;
      beforeAll(() => (process.env.PATH = `${join(import.meta.dir, "fixtures", "runtimes")}:${saved}`));
      afterAll(() => (process.env.PATH = saved));
      run();
    });
}

// Each worker gets its own clone of one bare remote, as separate machines would.
function gitLeases() {
  const root = mkdtempSync(join(tmpdir(), "factory-lease-"));
  Bun.spawnSync(["git", "init", "-q", "--bare", join(root, "origin.git")]);
  let n = 0;
  const clone = () => {
    const dir = join(root, `w${n++}`);
    Bun.spawnSync(["git", "init", "-q", dir]);
    Bun.spawnSync(["git", "remote", "add", "origin", join(root, "origin.git")], { cwd: dir });
    return new GitLeases(dir);
  };
  return { port: clone(), peer: clone };
}

// The http runtime against the protocol's reference server, on loopback.
function httpSandbox(): () => void {
  return () =>
    describe("against the reference sandbox server", () => {
      let sandbox: ReturnType<typeof startSandbox>;
      beforeAll(() => (sandbox = startSandbox("s3cret")));
      afterAll(() => sandbox.stop());
      executionContract(
        "http",
        () =>
          new HttpSandboxExecution(
            { kind: "http", url: sandbox.url, tokenEnv: "SANDBOX_TOKEN" },
            { SANDBOX_TOKEN: "s3cret" },
          ),
      );
    });
}

// A pool of one sandbox member, usage in memory: the contract runs on the member.
function sandboxPool(): () => void {
  return () =>
    describe("a pool over the reference sandbox server", () => {
      let sandbox: ReturnType<typeof startSandbox>;
      beforeAll(() => (sandbox = startSandbox("s3cret")));
      afterAll(() => sandbox.stop());
      executionContract("pool", () => {
        const member = new HttpSandboxExecution(
          { kind: "http", url: sandbox.url, tokenEnv: "SANDBOX_TOKEN" },
          { SANDBOX_TOKEN: "s3cret" },
        );
        return new PoolExecution(
          { kind: "pool", members: [{ runtime: "sb", minutes: 60 }] },
          { sb: member },
          { run: async () => ({ stdout: "", stderr: "ran on the fallback", code: 99 }) },
          new SqliteUsageStore(":memory:"),
        );
      });
    });
}

const REGISTRY: Record<string, () => void> = {
  "git-lease": () => leaseContract("git-lease", gitLeases),
  "github-store": () =>
    spendContract("github-store", () => {
      const github = new FakeGitHub([1, 2, 3, 4].map((n) => baseIssue(n, [])));
      github.repoLabels = new Set(); // a repo set up before the ledger label existed
      return {
        store: new GitHubSpend(github, "a/b", "me"),
        worker: (holder) => new GitHubSpend(github, "a/b", holder),
      };
    }),
  local: () => executionContract("local", () => new LocalExecution()),
  docker: onFakePath(() => executionContract("docker", () => new DockerExecution({ kind: "docker", image: "img" }))),
  lwpr: onFakePath(() => executionContract("lwpr", () => new LwprExecution())),
  // A launcher that is just `env`: the argv templating is what is under test.
  wrap: () =>
    executionContract(
      "wrap",
      () => new WrapExecution({ kind: "wrap", argv: ["env", "FACTORY_WRAPPED=1", "bash", "-c", "{cmd}"] }),
    ),
  "http-sandbox": httpSandbox(),
  pool: sandboxPool(),
  ssh: onFakePath(() =>
    executionContract(
      "ssh",
      () => new SshExecution({ kind: "ssh", host: "box", dir: join(tmpdir(), `factory-ssh-${process.pid}`) }),
    ),
  ),
};

describe("adapters", () => {
  test("every directory under src/adapters is registered", () => {
    const dirs = readdirSync(join(import.meta.dir, "..", "src", "adapters"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(Object.keys(REGISTRY).sort());
  });

  for (const run of Object.values(REGISTRY)) run();
  executionContract("recording fake", () => new RecordingExecution());
  leaseContract("in-memory fake", () => {
    const port = new FakeLeases();
    return { port, peer: () => port };
  });
});

describe("git-lease held()", () => {
  test("another clone sees each lease ref with its holder, and a release as expiresAt 0", async () => {
    const { port, peer } = gitLeases();
    const other = peer();
    expect(await other.held()).toEqual([]);
    expect(await port.acquire("issue-7", "w1", 30_000, 1_000)).toBe(true);
    expect(await port.acquire("issue-9", "w1", 30_000, 1_000)).toBe(true);
    await port.release("issue-9", "w1");
    const held = (await other.held()).sort((a, b) => a.key.localeCompare(b.key));
    expect(held).toEqual([
      { key: "issue-7", holder: "w1", expiresAt: 31_000 },
      { key: "issue-9", holder: "w1", expiresAt: 0 },
    ]);
  });

  // An empty list would read as "nobody holds anything"; the Settings page has to say it could not look.
  test("a remote it cannot read throws instead of reporting no leases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-lease-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    Bun.spawnSync(["git", "remote", "add", "origin", join(dir, "missing.git")], { cwd: dir });
    await expect(new GitLeases(dir).held()).rejects.toThrow(/ls-remote/);
  });
});
