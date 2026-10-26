// Verify in a clean room: a fresh clone at the head sha (nothing the build session left behind),
// no network (a test that passes only by calling out is not proof), and the holdouts copied in
// only after the clone, so the build never saw them. No usable sandbox means no run, never an open one.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The no-network wrapper for this OS, or undefined when there is none.
export function noNetworkPrefix(platform: string = process.platform): string[] | undefined {
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
    return ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"];
  if (platform === "linux") return ["unshare", "-rn"];
  return undefined;
}

export interface CleanRoomInput {
  readonly repoDir: string; // the build worktree: only its git objects are read
  readonly sha: string;
  // Holdouts come from the base commit, so an edit the build made to one never reaches the run.
  readonly holdouts: { readonly baseSha: string; readonly paths: readonly string[] };
  readonly cmd: string;
}

export interface CleanRoomResult {
  readonly ran: boolean;
  readonly exitCode: number;
  readonly tail: string;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]}: ${(await new Response(p.stderr).text()).trim()}`);
}

async function sandboxWorks(prefix: string[] | undefined): Promise<boolean> {
  if (!prefix) return false;
  try {
    return (await Bun.spawn([...prefix, "true"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}

export async function runCleanRoom(
  input: CleanRoomInput,
  prefix: string[] | undefined = noNetworkPrefix(),
): Promise<CleanRoomResult> {
  // A sandbox the host refuses (no user namespaces, say) fails closed, like no sandbox at all.
  const usable = await sandboxWorks(prefix);
  if (!usable || !prefix) return { ran: false, exitCode: -1, tail: "no usable network sandbox on this host" };
  const room = mkdtempSync(join(tmpdir(), "factory-clean-"));
  try {
    // --no-local copies objects instead of hardlinking, so the room shares nothing with the worktree.
    await git(tmpdir(), "clone", "--quiet", "--no-local", "--no-checkout", input.repoDir, room);
    await git(room, "checkout", "--quiet", "--detach", input.sha);
    if (input.holdouts.paths.length) {
      const paths = input.holdouts.paths.map((p) => join(room, p));
      for (const p of paths) rmSync(p, { recursive: true, force: true });
      await git(room, "checkout", input.holdouts.baseSha, "--", ...input.holdouts.paths).catch(() => undefined);
    }
    const proc = Bun.spawn([...prefix, "bash", "-c", input.cmd], { cwd: room, stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ran: true, exitCode, tail: `${out}${err}`.slice(-2000) };
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
}
