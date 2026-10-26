// Verify's clean room (spec 10 verify-clean-room): holdouts run in a fresh clone of the committed head,
// never the agent's worktree, so nothing it left on disk is graded. Hidden paths come from origin/<base>
// only after checkout, and the command runs with no network through the wrap runtime.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CMD, WrapExecution } from "./adapters/wrap/execution";
import { sparseCheckoutPatterns } from "./git";
import type { ExecResult, ExecutionPort } from "./ports/execution";

// Everything allowed except sockets: no DNS, no TCP, no loopback.
export const NO_NETWORK_PROFILE = "(version 1)(allow default)(deny network*)";

// The launcher that denies the network on this platform, or undefined when there is none.
export function noNetworkArgv(platform: NodeJS.Platform = process.platform): string[] | undefined {
  if (platform === "darwin") return ["sandbox-exec", "-p", NO_NETWORK_PROFILE, "bash", "-c", CMD];
  if (platform === "linux") return ["unshare", "--user", "--map-root-user", "--net", "bash", "-c", CMD];
  return undefined;
}

// A platform with no sandbox fails closed: the run is a runtime failure, never a run with network.
class NoSandbox implements ExecutionPort {
  constructor(private readonly platform: string) {}
  async run(): Promise<ExecResult> {
    const why = `verify: no network sandbox on ${this.platform}`;
    return { stdout: "", stderr: why, code: 1, runtimeFailed: why };
  }
}

export function noNetworkExecution(platform: NodeJS.Platform = process.platform): ExecutionPort {
  const argv = noNetworkArgv(platform);
  return argv ? new WrapExecution({ kind: "wrap", argv }) : new NoSandbox(platform);
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function must(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`clean room: git ${args.slice(0, 2).join(" ")} failed: ${r.err}`);
  return r.out;
}

// A fresh directory holding the worktree's HEAD commit, with `hidden` taken from origin/<base>.
// The caller removes it. Only committed content gets in: the clone reads the object store, and
// the worktree's files are never copied.
export function cleanCheckout(worktreeDir: string, base: string, hidden: readonly string[]): string {
  const head = must(["rev-parse", "HEAD"], worktreeDir);
  const common = must(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreeDir);
  const baseSha = git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], worktreeDir);
  const dir = mkdtempSync(join(tmpdir(), "factory-clean-room-"));
  try {
    must(["clone", "-q", "--no-checkout", common, dir], dir);
    // A remote that leads nowhere: the run cannot fetch or push from inside the room.
    must(["config", "remote.origin.url", "/factory/withheld"], dir);
    if (hidden.length) {
      must(["sparse-checkout", "init", "--no-cone"], dir);
      must(["sparse-checkout", "set", ...sparseCheckoutPatterns(hidden)], dir);
    }
    must(["checkout", "-q", "--detach", head], dir);
    if (hidden.length && baseSha.ok) {
      const tar = Bun.spawnSync(["git", "archive", baseSha.out, "--", ...hidden], { cwd: dir, stdout: "pipe" });
      if (tar.exitCode === 0) Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: tar.stdout });
    }
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
