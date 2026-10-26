// spec 10 verify-clean-room: the holdout run sees only the committed head, with holdouts from the base
// copied in after checkout, and it has no network.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecution } from "../src/adapters/local/execution";
import { NO_NETWORK_PROFILE, noNetworkArgv, noNetworkExecution } from "../src/clean-room";
import { ShellHoldoutRunner } from "../src/holdout";

// Real git repos on a loaded machine take seconds, past bun's 5s default.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

// A factory clone with a worktree on the build's branch, the way src/git.ts lays them out.
function buildWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-clean-room-test-"));
  dirs.push(root);
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "seed");
  write(join(root, "seed"), { "src.txt": "before\n", "holdout/expect.txt": "pristine\n" });
  git(join(root, "seed"), "add", "-A");
  git(join(root, "seed"), "commit", "-q", "-m", "base");
  git(join(root, "seed"), "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "origin.git", "clone");
  git(join(root, "clone"), "worktree", "add", "-q", "-b", "factory/issue-1", "../wt", "origin/main");
  const wt = join(root, "wt");
  write(wt, { "src.txt": "after\n", "holdout/expect.txt": "tampered\n", "holdout/extra.txt": "planted\n" });
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "build");
  write(wt, { "agent-left.txt": "PASS\n" });
  return wt;
}

// Live where this machine's sandbox can start; a CI runner that forbids user namespaces skips it.
const launcher = noNetworkArgv();
const sandboxWorks =
  !!launcher &&
  Bun.spawnSync(
    launcher.map((a) => (a === "{cmd}" ? "true" : a)),
    { stderr: "ignore" },
  ).exitCode === 0;

describe("verify clean room", () => {
  test("verify runs in a clean room: an agent-left file is not seen and holdouts come from the base", async () => {
    const wt = buildWorktree();
    const runner = new ShellHoldoutRunner(new LocalExecution());
    const out = await runner.run(wt, "main", {
      paths: ["holdout/**"],
      cmd: "pwd; ls -A; cat src.txt holdout/expect.txt; test -e holdout/extra.txt && echo EXTRA; true",
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("after");
    expect(out.stdout).toContain("pristine");
    expect(out.stdout).not.toContain("tampered");
    expect(out.stdout).not.toContain("EXTRA");
    expect(out.stdout).not.toContain("agent-left.txt");
    expect(out.stdout.split("\n")[0]).not.toBe(wt);
    // The room is removed after the run, and the agent's worktree is left as it was.
    expect(existsSync(out.stdout.split("\n")[0]!)).toBe(false);
    expect(existsSync(join(wt, "agent-left.txt"))).toBe(true);
  });

  test("a holdout that only passes on an agent-left file fails in the clean room", async () => {
    const wt = buildWorktree();
    const out = await new ShellHoldoutRunner(new LocalExecution()).run(wt, "main", {
      paths: ["holdout/**"],
      cmd: "grep -q PASS agent-left.txt",
    });
    expect(out.code).not.toBe(0);
  });

  test("holdouts fail closed when the base does not resolve: the command never runs", async () => {
    const wt = buildWorktree();
    git(join(wt, "..", "clone"), "update-ref", "-d", "refs/remotes/origin/main");
    const out = await new ShellHoldoutRunner(new LocalExecution()).run(wt, "main", {
      paths: ["holdout/**"],
      cmd: "echo RAN",
    });
    expect(out.code).toBe(1);
    expect(out.stdout).not.toContain("RAN");
    expect(out.stderr).toContain("clean room");
  });

  test("holdouts fail closed when a holdout path is not on the base", async () => {
    const wt = buildWorktree();
    const out = await new ShellHoldoutRunner(new LocalExecution()).run(wt, "main", {
      paths: ["missing/**"],
      cmd: "echo RAN",
    });
    expect(out.code).toBe(1);
    expect(out.stdout).not.toContain("RAN");
  });

  // A tar that drops the extract (exit 0) or fails it (exit 1): either way the command never runs.
  for (const code of [0, 1])
    test(`holdouts fail closed when the extract leaves files out (tar -x exits ${code})`, async () => {
      const wt = buildWorktree();
      const bin = mkdtempSync(join(tmpdir(), "factory-clean-room-bin-"));
      dirs.push(bin);
      const real = Bun.which("tar")!;
      writeFileSync(
        join(bin, "tar"),
        `#!/bin/sh\ncase "$1" in -x) cat >/dev/null; exit ${code};; esac\nexec ${real} "$@"\n`,
      );
      chmodSync(join(bin, "tar"), 0o755);
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
      try {
        const out = await new ShellHoldoutRunner(new LocalExecution()).run(wt, "main", {
          paths: ["holdout/**"],
          cmd: "echo RAN",
        });
        expect(out.code).toBe(1);
        expect(out.stdout).not.toContain("RAN");
        expect(out.stderr).toContain(code ? "tar failed" : "holdouts not restored");
      } finally {
        process.env.PATH = path;
      }
    });

  test("a worktree that is not a git checkout fails the run instead of grading the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-clean-room-nogit-"));
    dirs.push(dir);
    const out = await new ShellHoldoutRunner(new LocalExecution()).run(dir, "main", { paths: [], cmd: "true" });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("clean room");
  });

  test("the no-network launcher: sandbox-exec on macOS, a new net namespace on Linux, none elsewhere", async () => {
    expect(noNetworkArgv("darwin")).toEqual(["sandbox-exec", "-p", NO_NETWORK_PROFILE, "bash", "-c", "{cmd}"]);
    expect(NO_NETWORK_PROFILE).toContain("(deny network*)");
    expect(noNetworkArgv("linux")).toEqual(["unshare", "--user", "--map-root-user", "--net", "bash", "-c", "{cmd}"]);
    expect(noNetworkArgv("win32")).toBeUndefined();
    const closed = await noNetworkExecution("win32").run("true", tmpdir());
    expect(closed.code).toBe(1);
    expect(closed.runtimeFailed).toContain("no network sandbox");
  });

  test.skipIf(!sandboxWorks)("the holdout command cannot open a socket, even to loopback", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const probe = `exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo connected`;
      const open = await new LocalExecution().run(probe, tmpdir());
      expect(open.stdout).toContain("connected");
      const denied = await noNetworkExecution().run(probe, tmpdir());
      expect(denied.code).not.toBe(0);
      expect(denied.stdout).not.toContain("connected");
    } finally {
      server.stop(true);
    }
  });
});
