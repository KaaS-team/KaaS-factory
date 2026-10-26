// Verify-stage holdout tests (plan v2.11.0 item C): a test suite no stage's
// agent ever sees (src/git.ts's sparse-checkout exclusion keeps the paths out
// of the worktree from the moment it's created) and only this stage runs,
// in src/clean-room.ts's fresh clone with the holdout paths taken from the base
// branch, so a build that somehow altered them is never graded against its
// own edit. Mirrors src/gates.ts's shape: an injectable runner plus a pure
// orchestration function, so tests never need a real git repo.

import { rmSync } from "node:fs";
import { cleanCheckout, noNetworkExecution } from "./clean-room";
import type { HoldoutConfig } from "./config";
import type { ExecutionPort } from "./ports/execution";

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

export class ShellHoldoutRunner implements HoldoutRunner {
  constructor(private readonly exec: ExecutionPort = noNetworkExecution()) {}
  async run(
    worktreeDir: string,
    base: string,
    holdout: HoldoutConfig,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    let room: string;
    try {
      room = cleanCheckout(worktreeDir, base, holdout.paths);
    } catch (err) {
      return { stdout: "", stderr: (err as Error).message, code: 1 };
    }
    try {
      return await this.exec.run(holdout.cmd, room);
    } finally {
      rmSync(room, { recursive: true, force: true });
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
