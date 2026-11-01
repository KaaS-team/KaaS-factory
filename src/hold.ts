// A human's hold on a run (`factory takeover`, then `factory release`): while the marker beside the
// issue's worktree exists, the runner's pushes are refused so it cannot overwrite the human's work.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandResult } from "./github";

export function holdMarker(worktreeDir: string): string {
  return `${worktreeDir.replace(/\/+$/, "")}.hold`;
}

export function holdRun(worktreeDir: string, who: string): void {
  mkdirSync(dirname(holdMarker(worktreeDir)), { recursive: true });
  writeFileSync(holdMarker(worktreeDir), `${who}\n`);
}

export function releaseRun(worktreeDir: string): boolean {
  const held = isHeld(worktreeDir);
  rmSync(holdMarker(worktreeDir), { force: true });
  return held;
}

export function isHeld(worktreeDir: string): boolean {
  return existsSync(holdMarker(worktreeDir));
}

// The refusal a push returns while the run is held, or undefined when it may go ahead.
export function heldRefusal(worktreeDir: string): CommandResult | undefined {
  if (!isHeld(worktreeDir)) return undefined;
  return { stdout: "", stderr: "refusing to push: a human holds this run (factory release to hand it back)", code: 1 };
}
