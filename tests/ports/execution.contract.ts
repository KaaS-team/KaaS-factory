// What every ExecutionPort adapter must do, whatever machine it runs on.
// An adapter's test calls this with a factory for a fresh instance.

import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionPort } from "../../src/ports/execution";

export function executionContract(name: string, make: () => ExecutionPort): void {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-exec-")));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test(`${name}: captures stdout, stderr and the exit code apart`, () =>
    withDir(async (dir) => {
      const r = await make().run("echo out; echo err >&2; exit 3", dir);
      expect(r).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
    }));

  // A remote runtime runs on a copy elsewhere, so the contract is the files, not the path.
  test(`${name}: sees the worktree's files`, () =>
    withDir(async (dir) => {
      writeFileSync(join(dir, "marker.txt"), "here\n");
      expect(await make().run("cat marker.txt", dir)).toEqual({ stdout: "here\n", stderr: "", code: 0 });
    }));

  test(`${name}: quotes survive the trip`, () =>
    withDir(async (dir) => {
      expect((await make().run(`echo "it's" 'a "test"' $((1+2))`, dir)).stdout).toBe(`it's a "test" 3\n`);
    }));

  test(`${name}: the command line is bash, pipes and && included`, () =>
    withDir(async (dir) => {
      const r = await make().run("printf 'a\\nb\\n' | wc -l | tr -d ' ' && [[ 1 == 1 ]] && echo yes", dir);
      expect(r).toEqual({ stdout: "2\nyes\n", stderr: "", code: 0 });
    }));

  test(`${name}: a missing command is a non-zero exit, not a throw`, () =>
    withDir(async (dir) => {
      const r = await make().run("definitely-not-a-command-xyz", dir);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("definitely-not-a-command-xyz");
    }));
}
