// `--repo owner/name` (Docker/CI modes) has to work against a machine with
// no clone on disk at all: first call clones, every call after fetches and
// fast-forwards. Real git against a local bare repo standing in for GitHub
// (same pattern as git.test.ts — a fake runner can't prove a real clone/
// fetch/reset round trip).

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";

// Real git processes: a loaded machine can exceed bun's 5s default.
setDefaultTimeout(30_000);
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCommandRunner } from "../src/git";
import { cloneDirFor, ensureRepoClone, GH_CREDENTIAL_HELPER } from "../src/repo";

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${cmd.join(" ")} (cwd=${cwd}) failed: ${stderr}`);
  return stdout;
}

async function bareOrigin(root: string): Promise<string> {
  const bare = join(root, "origin.git");
  mkdirSync(bare, { recursive: true });
  await run(["init", "--bare", "-b", "main", bare], root);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await run(["init", "-b", "main", seed], seed);
  await run(["config", "user.email", "t@example.com"], seed);
  await run(["config", "user.name", "t"], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  await run(["add", "-A"], seed);
  await run(["commit", "-m", "seed"], seed);
  await run(["remote", "add", "origin", bare], seed);
  await run(["push", "origin", "main"], seed);
  return bare;
}

describe("ensureRepoClone", () => {
  test("clones from github.com, or from the Enterprise host GH_HOST names", async () => {
    const root = tmpRoot();
    for (const [gh, url] of [
      [undefined, "https://github.com/acme/widgets.git"],
      ["ghe.acme.io", "https://ghe.acme.io/acme/widgets.git"],
    ] as const) {
      const calls: string[][] = [];
      const runner = { run: async (args: string[]) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) };
      const env = { HOME: root, FACTORY_HOME: join(root, gh ?? "dotcom"), ...(gh ? { GH_HOST: gh } : {}) };
      await ensureRepoClone(runner, "acme/widgets", { env });
      expect(calls[0]!.slice(0, 2)).toEqual(["clone", url]);
    }
  });

  test("clones into FACTORY_HOME/repos on first call", async () => {
    const root = tmpRoot();
    const bare = await bareOrigin(root);
    const env = { HOME: root, FACTORY_HOME: join(root, ".factory") };
    const runner = new GitCommandRunner();

    const dir = await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    expect(dir).toBe(cloneDirFor("acme/widgets", env));
    expect(await Bun.file(join(dir, "README.md")).exists()).toBe(true);
  });

  test("the clone pushes through gh's login and nothing else, on first and later calls", async () => {
    const root = tmpRoot();
    const bare = await bareOrigin(root);
    const env = { HOME: root, FACTORY_HOME: join(root, ".factory") };
    const runner = new GitCommandRunner();
    const dir = await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    // The empty entry resets whatever the system gitconfig set (osxkeychain), so gh's is the one that runs.
    expect(await run(["config", "--local", "--get-all", "credential.helper"], dir)).toBe(`\n${GH_CREDENTIAL_HELPER}\n`);
    // A clone made before v3.2 has no helper of its own; the next call gives it one.
    await run(["config", "--local", "--unset-all", "credential.helper"], dir);
    await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    expect(await run(["config", "--local", "--get-all", "credential.helper"], dir)).toBe(`\n${GH_CREDENTIAL_HELPER}\n`);
  });

  test("a second call fetches and fast-forwards instead of re-cloning", async () => {
    const root = tmpRoot();
    const bare = await bareOrigin(root);
    const env = { HOME: root, FACTORY_HOME: join(root, ".factory") };
    const runner = new GitCommandRunner();

    const dir = await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });

    // Simulate a new commit landing on origin between two container starts.
    const seed = join(root, "seed");
    writeFileSync(join(seed, "NEW.md"), "new\n");
    await run(["add", "-A"], seed);
    await run(["commit", "-m", "second"], seed);
    await run(["push", "origin", "main"], seed);

    const dirAgain = await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    expect(dirAgain).toBe(dir);
    expect(await Bun.file(join(dir, "NEW.md")).exists()).toBe(true);
  });

  test("discards local drift instead of keeping it (stateless clone)", async () => {
    const root = tmpRoot();
    const bare = await bareOrigin(root);
    const env = { HOME: root, FACTORY_HOME: join(root, ".factory") };
    const runner = new GitCommandRunner();

    const dir = await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    writeFileSync(join(dir, "LOCAL.md"), "should not survive\n");
    await run(["add", "-A"], dir);
    await run(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "local only"], dir);

    await ensureRepoClone(runner, "acme/widgets", { env, remoteUrl: bare });
    expect(await Bun.file(join(dir, "LOCAL.md")).exists()).toBe(false);
  });
});
