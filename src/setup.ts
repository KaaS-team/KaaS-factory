// A fresh `git worktree add` has none of the target's dependencies installed
// (no node_modules, no vendor dir), so the first agent's shell commands would
// otherwise fail on install alone. `config.setup` (e.g. ["npm ci
// --prefer-offline"]) runs once per worktree, before any stage (plan v2.6.2
// item 4; the "pre" idea from owainlewis/factory, no code copied). A marker
// under .factory/runs/ — already excluded from commitAll's pathspec, so it
// never lands in a commit — makes this idempotent: a restart on the same
// worktree does not re-run npm ci.

import type { ExecutionPort } from "./ports/execution";
import { LocalExecution } from "./adapters/local/execution";

export type SetupRunner = ExecutionPort;
export const ShellSetupRunner = LocalExecution;

export interface SetupResult {
  readonly ok: boolean;
  readonly ran: boolean; // false when the marker already existed or there was nothing to run
  readonly log: string;
}

const MARKER = ".factory/runs/setup.done";

export async function ensureSetup(
  runner: SetupRunner,
  worktreeDir: string,
  commands: readonly string[],
): Promise<SetupResult> {
  if (commands.length === 0) return { ok: true, ran: false, log: "" };
  const marker = `${worktreeDir}/${MARKER}`;
  if (await Bun.file(marker).exists()) return { ok: true, ran: false, log: "" };

  const lines: string[] = [];
  for (const cmd of commands) {
    const result = await runner.run(cmd, worktreeDir);
    lines.push(`$ ${cmd}`, result.stdout.trim(), result.stderr.trim());
    if (result.code !== 0) return { ok: false, ran: true, log: lines.filter(Boolean).join("\n") };
  }
  await Bun.write(marker, `${new Date().toISOString()}\n`);
  return { ok: true, ran: true, log: lines.filter(Boolean).join("\n") };
}
