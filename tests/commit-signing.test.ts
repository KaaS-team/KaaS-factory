import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigningRequiredError, signingProblems, withSigning } from "../src/commit-signing";
import { GitCommandRunner } from "../src/git";

setDefaultTimeout(30_000);

const roots: string[] = [];
function tmpRoot(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "factory-sign-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("withSigning", () => {
  test("ssh: puts -c pairs before the subcommand and -S after it", () => {
    expect(withSigning(["commit", "-m", "x"], { format: "ssh", key: "KEYREF" })).toEqual([
      "-c",
      "gpg.format=ssh",
      "-c",
      "user.signingkey=KEYREF",
      "commit",
      "-S",
      "-m",
      "x",
    ]);
  });

  test("gpg maps to git's openpgp format and commit-tree is signed too", () => {
    expect(withSigning(["commit-tree", "T", "-m", "x"], { format: "gpg", key: "ID" })).toEqual([
      "-c",
      "gpg.format=openpgp",
      "-c",
      "user.signingkey=ID",
      "commit-tree",
      "-S",
      "T",
      "-m",
      "x",
    ]);
  });

  test("other subcommands and an absent config pass through", () => {
    expect(withSigning(["push", "origin"], { format: "ssh", key: "K", required: true })).toEqual(["push", "origin"]);
    expect(withSigning(["commit", "-m", "x"], undefined)).toEqual(["commit", "-m", "x"]);
  });

  test("required without a key refuses; optional without a key commits unsigned", () => {
    expect(() => withSigning(["commit", "-m", "x"], { format: "ssh", required: true })).toThrow(SigningRequiredError);
    expect(() => withSigning(["commit", "-m", "x"], { format: "ssh", key: "  ", required: true })).toThrow(
      "refusing to commit unsigned",
    );
    expect(withSigning(["commit", "-m", "x"], { format: "ssh" })).toEqual(["commit", "-m", "x"]);
  });
});

describe("signingProblems", () => {
  test("accepts a valid block and flags each bad field", () => {
    expect(signingProblems(undefined)).toEqual([]);
    expect(signingProblems({ format: "ssh", key: "K", required: true })).toEqual([]);
    expect(signingProblems({ format: "pgp", key: "", required: "yes", extra: 1 })).toEqual([
      "commits.signing.format: expected one of ssh, gpg",
      "commits.signing.key: expected a non-empty string",
      "commits.signing.required: expected a boolean",
      "commits.signing.extra: unknown key (allowed: format, key, required)",
    ]);
    expect(signingProblems({ key: "K" })).toEqual(["commits.signing.format: required"]);
  });
});

describe("GitCommandRunner signing", () => {
  async function repo(): Promise<{ dir: string; env: Record<string, string>; log: string }> {
    const dir = tmpRoot();
    const sh = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
    sh(["init", "-q"]);
    sh(["config", "commit.gpgsign", "false"]);
    sh(["config", "user.name", "t"]);
    sh(["config", "user.email", "t@example.com"]);
    const log = join(dir, "..", `${dir.split("/").pop()}-gpg.log`);
    const prog = join(dir, "..", `${dir.split("/").pop()}-gpg.sh`);
    roots.push(log, prog);
    writeFileSync(
      prog,
      `#!/bin/sh\necho "$@" >> "${log}"\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED " >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n"\n`,
    );
    chmodSync(prog, 0o755);
    return {
      dir,
      log,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gpg.program", GIT_CONFIG_VALUE_0: prog },
    };
  }

  test("a signing config makes the commit carry a signature made with the configured key", async () => {
    const { dir, env, log } = await repo();
    const runner = new GitCommandRunner({ signing: { format: "gpg", key: "TESTKEYID" } });
    const r = await runner.run(["commit", "--allow-empty", "-m", "signed"], { cwd: dir, env });
    expect(r.code).toBe(0);
    const raw = (await runner.run(["cat-file", "-p", "HEAD"], { cwd: dir })).stdout;
    expect(raw).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    expect(readFileSync(log, "utf8")).toContain("TESTKEYID");
  });

  test("required signing with no key throws before git runs and makes no commit", async () => {
    const { dir } = await repo();
    const runner = new GitCommandRunner({ signing: { format: "ssh", required: true } });
    await expect(runner.run(["commit", "--allow-empty", "-m", "x"], { cwd: dir })).rejects.toThrow(
      SigningRequiredError,
    );
    const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { cwd: dir });
    expect(head.exitCode).toBe(128);
  });

  test("no signing config leaves the commit unsigned", async () => {
    const { dir, env } = await repo();
    const runner = new GitCommandRunner();
    expect((await runner.run(["commit", "--allow-empty", "-m", "plain"], { cwd: dir, env })).code).toBe(0);
    expect((await runner.run(["cat-file", "-p", "HEAD"], { cwd: dir })).stdout).not.toContain("gpgsig");
  });
});
