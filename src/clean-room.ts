// Verify's clean room (spec 10 verify-clean-room): holdouts run in a fresh clone of the committed head,
// never the agent's worktree, so nothing it left on disk is graded. Hidden paths come from origin/<base>
// only after checkout, and the command runs with no network through the wrap runtime.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

// Copies `hidden` from baseSha into dir, failing closed: a missing base, a failed archive or extract,
// or a listed file absent afterwards throws, so holdouts never run without the base's copy.
function restoreHidden(dir: string, baseSha: string, hidden: readonly string[]): void {
  const archive = Bun.spawnSync(["git", "archive", baseSha, "--", ...hidden], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (archive.exitCode !== 0) throw new Error(`clean room: git archive failed: ${archive.stderr.toString().trim()}`);
  const io = { stdin: archive.stdout, stdout: "pipe", stderr: "pipe", env: process.env } as const;
  const list = Bun.spawnSync(["tar", "-t"], io);
  const extract = Bun.spawnSync(["tar", "-x", "-C", dir], io);
  if (list.exitCode !== 0 || extract.exitCode !== 0)
    throw new Error(`clean room: tar failed: ${list.stderr.toString().trim()} ${extract.stderr.toString().trim()}`);
  const files = list.stdout
    .toString()
    .split("\n")
    .filter((f) => f && !f.endsWith("/") && f !== "pax_global_header");
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (!files.length || missing.length)
    throw new Error(`clean room: holdouts not restored: ${missing.join(", ") || "none listed"}`);
}

// A fresh directory holding `head` (the worktree's HEAD by default), with `hidden` taken from
// origin/<base>. The caller removes it. Only committed content gets in: the clone reads the
// object store, and the worktree's files are never copied.
export function cleanCheckout(worktreeDir: string, base: string, hidden: readonly string[], head?: string): string {
  const commit = must(["rev-parse", "--verify", `${head ?? "HEAD"}^{commit}`], worktreeDir);
  const common = must(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreeDir);
  const baseSha = hidden.length
    ? must(["rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`], worktreeDir)
    : "";
  const dir = mkdtempSync(join(tmpdir(), "factory-clean-room-"));
  try {
    must(["clone", "-q", "--no-checkout", common, dir], dir);
    // A remote that leads nowhere: the run cannot fetch or push from inside the room.
    must(["config", "remote.origin.url", "/factory/withheld"], dir);
    if (hidden.length) {
      must(["sparse-checkout", "init", "--no-cone"], dir);
      must(["sparse-checkout", "set", ...sparseCheckoutPatterns(hidden)], dir);
    }
    must(["checkout", "-q", "--detach", commit], dir);
    if (hidden.length) restoreHidden(dir, baseSha, hidden);
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
