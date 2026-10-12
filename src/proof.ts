// The revert-and-restore proof under `proof: test`, run by the runner instead of the verify
// session: put the base branch's version of every non-test file back, run the repo's `test`
// gate, and record whether it failed. On #95 the verify session spent five Opus turns doing
// this by hand. The verify skill still judges whether the failure is for the stated reason,
// from the output tail this writes to proof.json. Mirrors src/holdout.ts: an injectable
// runner plus a pure function, so tests never need a real agent.

import type { CommandResult } from "./github";

// "unavailable": the repo has no test gate, so nothing could prove the change. It is shown
// in the PR's run summary rather than passing silently.
export type ProofStatus = "bites" | "passes-without" | "no-tests" | "skipped" | "unavailable";

export interface ProofResult {
  readonly status: ProofStatus;
  readonly reverted: string[];
  readonly tests: string[];
  readonly cmd: string;
  readonly exitCode?: number;
  readonly tail: string;
  // Appended by template/.factory/mutate.sh --proof when verify runs a plan's mutation (#42).
  readonly mutations?: readonly { file: string; status: "bites" | "survives"; failed: string; cmd: string; exitCode: number; tail: string }[];
}

// A test by its path, the conventions bun, jest, vitest, pytest, go and rspec use.
export const TEST_PATH = [/(^|\/)(tests?|__tests__|spec)\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)test_[^/]*\.py$/, /_test\.(py|go)$/, /_spec\.rb$/];

export function isTestPath(path: string): boolean {
  return TEST_PATH.some((re) => re.test(path));
}

export interface ProofGit {
  // Name-status lines of HEAD against the merge base with origin/<base>: "M\tpath", "A\tpath".
  changes(worktree: string, base: string): Promise<{ status: string; path: string }[]>;
  restoreFromBase(worktree: string, base: string, paths: string[]): Promise<void>;
  remove(worktree: string, paths: string[]): Promise<void>;
  restoreHead(worktree: string): Promise<void>;
  dirty(worktree: string): Promise<string[]>;
  test(worktree: string, cmd: string): Promise<CommandResult>;
}

// The factory's own files never count as the change under test.
const FACTORY_OWNED = /^\.(factory|claude|agents)\//;

export async function runProof(git: ProofGit, worktree: string, base: string, proof: "test" | "check" | undefined, testCmd: string | undefined): Promise<ProofResult> {
  const cmd = testCmd ?? "";
  if (proof === "check") return { status: "skipped", reverted: [], tests: [], cmd, tail: "plan proof is check: re-run the named checks" };
  if (!testCmd) return { status: "unavailable", reverted: [], tests: [], cmd, tail: "no gate has role test (or is named test) in .factory/config.json" };
  const changes = (await git.changes(worktree, base)).filter((c) => !FACTORY_OWNED.test(c.path));
  const tests = changes.filter((c) => isTestPath(c.path) && c.status !== "D").map((c) => c.path);
  const impl = changes.filter((c) => !isTestPath(c.path));
  if (tests.length === 0) return { status: "no-tests", reverted: [], tests, cmd, tail: "the diff adds or changes no test file" };
  const added = impl.filter((c) => c.status === "A").map((c) => c.path);
  const existing = impl.filter((c) => c.status !== "A").map((c) => c.path);
  let result: CommandResult;
  try {
    if (existing.length > 0) await git.restoreFromBase(worktree, base, existing);
    if (added.length > 0) await git.remove(worktree, added);
    result = await git.test(worktree, testCmd);
  } finally {
    await git.restoreHead(worktree);
  }
  const left = await git.dirty(worktree);
  if (left.length > 0) throw new Error(`proof: the worktree is not clean after restoring HEAD: ${left.join(", ")}`);
  const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
  return { status: result.code === 0 ? "passes-without" : "bites", reverted: [...existing, ...added], tests, cmd, exitCode: result.code, tail };
}

async function sh(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

async function git(args: string[], cwd: string): Promise<CommandResult> {
  const r = await sh(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r;
}

export class ShellProofGit implements ProofGit {
  async changes(worktree: string, base: string) {
    const out = (await git(["diff", "--name-status", "--no-renames", `origin/${base}...HEAD`], worktree)).stdout;
    return out.split("\n").filter(Boolean).map((line) => {
      const [status, path] = line.split("\t") as [string, string];
      return { status: status.slice(0, 1), path };
    });
  }
  async restoreFromBase(worktree: string, base: string, paths: string[]) {
    const mergeBase = (await git(["merge-base", `origin/${base}`, "HEAD"], worktree)).stdout.trim();
    await git(["restore", `--source=${mergeBase}`, "--worktree", "--", ...paths], worktree);
  }
  async remove(worktree: string, paths: string[]) {
    await git(["rm", "-q", "--cached", "--", ...paths], worktree);
    await sh(["rm", "-f", "--", ...paths], worktree);
  }
  async restoreHead(worktree: string) {
    await git(["reset", "-q", "--", "."], worktree);
    await git(["restore", "--source=HEAD", "--worktree", "--", ":!.factory/runs"], worktree);
  }
  async dirty(worktree: string) {
    const out = (await git(["status", "--porcelain", "--untracked-files=no", "--", ".", ":!.factory/runs"], worktree)).stdout;
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  }
  test(worktree: string, cmd: string) {
    return sh(["bash", "-c", cmd], worktree);
  }
}
