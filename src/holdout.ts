// Verify-stage holdout tests (plan v2.11.0 item C): a test suite no stage's
// agent ever sees (src/git.ts's sparse-checkout exclusion keeps the paths out
// of the worktree from the moment it's created) and only this stage runs,
// against a scratch copy with the holdout paths force-restored from the base
// branch, so a build that somehow altered them is never graded against its
// own edit. Mirrors src/gates.ts's shape: an injectable runner plus a pure
// orchestration function, so tests never need a real git repo.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HoldoutConfig } from "./config";

export interface HoldoutResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface HoldoutRunner {
  run(
    worktreeDir: string,
    base: string,
    holdout: HoldoutConfig,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

async function exec(
  cmd: string[],
  cwd: string,
  stdin?: ReadableStream,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, { cwd, stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

export class ShellHoldoutRunner implements HoldoutRunner {
  async run(
    worktreeDir: string,
    base: string,
    holdout: HoldoutConfig,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const scratch = mkdtempSync(join(tmpdir(), "factory-holdout-"));
    try {
      // The built tree, from git's object store rather than the working
      // directory: sparse-checkout only hides paths from the checkout, never
      // from HEAD, so this alone already carries whatever holdout content the
      // build's own commits left in place.
      const built = Bun.spawn(["git", "archive", "HEAD"], { cwd: worktreeDir, stdout: "pipe" });
      await exec(["tar", "-x", "-C", scratch], scratch, built.stdout);
      await built.exited;

      // Force-overlay the pristine, base-branch content on top: defense in
      // depth in case a holdout path ever reached HEAD altered, despite the
      // boundary check and the sparse-checkout exclusion both refusing that.
      if (holdout.paths.length > 0) {
        const pristine = Bun.spawn(["git", "archive", `origin/${base}`, "--", ...holdout.paths], {
          cwd: worktreeDir,
          stdout: "pipe",
        });
        await exec(["tar", "-x", "-C", scratch], scratch, pristine.stdout);
        await pristine.exited;
      }

      return await exec(["bash", "-c", holdout.cmd], scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

// Truncation mirrors src/gates.ts's own convention: a failure detail is the
// test name and assertion message, never a full log dump of the source.
export async function runHoldout(
  runner: HoldoutRunner,
  worktreeDir: string,
  base: string,
  holdout: HoldoutConfig,
): Promise<HoldoutResult> {
  const result = await runner.run(worktreeDir, base, holdout);
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return { ok: result.code === 0, detail: combined.slice(-2000) };
}
