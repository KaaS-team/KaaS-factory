// The revert-and-restore proof under `proof: test`, run by the runner instead of the verify
// session: put the base branch's version of every non-test file back, run the repo's `test`
// gate, and record whether it failed. On #95 the verify session spent five Opus turns doing
// this by hand. The verify skill still judges whether the failure is for the stated reason,
// from the output tail this writes to proof.json. Mirrors src/holdout.ts: an injectable
// runner plus a pure function, so tests never need a real agent.

import { type GateSpec, type PackageSpec, testGate } from "./config";
import type { CommandResult } from "./github";
import { touchedPackages } from "./risk";

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
  readonly mutations?: readonly {
    file: string;
    status: "bites" | "survives";
    failed: string;
    cmd: string;
    exitCode: number;
    tail: string;
  }[];
}

// A test by its path, the conventions bun, jest, vitest, pytest, go and rspec use.
export const TEST_PATH = [
  /(^|\/)(tests?|__tests__|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /_spec\.rb$/,
];

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
  // Where plan mutations are applied and run; absent means the plan's mutations are not run.
  readonly mutations?: MutationIO;
}

// The factory's own files never count as the change under test.
const FACTORY_OWNED = /^\.(factory|claude|agents)\//;

export async function runProof(
  git: ProofGit,
  worktree: string,
  base: string,
  proof: "test" | "check" | undefined,
  testCmd: string | undefined,
): Promise<ProofResult> {
  const cmd = testCmd ?? "";
  if (proof === "check")
    return { status: "skipped", reverted: [], tests: [], cmd, tail: "plan proof is check: re-run the named checks" };
  if (!testCmd)
    return {
      status: "unavailable",
      reverted: [],
      tests: [],
      cmd,
      tail: "no gate has role test (or is named test) in .factory/config.json",
    };
  const changes = (await git.changes(worktree, base)).filter((c) => !FACTORY_OWNED.test(c.path));
  const tests = changes.filter((c) => isTestPath(c.path) && c.status !== "D").map((c) => c.path);
  const impl = changes.filter((c) => !isTestPath(c.path));
  if (tests.length === 0)
    return { status: "no-tests", reverted: [], tests, cmd, tail: "the diff adds or changes no test file" };
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
  return {
    status: result.code === 0 ? "passes-without" : "bites",
    reverted: [...existing, ...added],
    tests,
    cmd,
    exitCode: result.code,
    tail,
  };
}

async function sh(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function git(args: string[], cwd: string): Promise<CommandResult> {
  const r = await sh(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r;
}

export class ShellProofGit implements ProofGit {
  readonly mutations = new ShellMutationIO();
  async changes(worktree: string, base: string) {
    const out = (await git(["diff", "--name-status", "--no-renames", `origin/${base}...HEAD`], worktree)).stdout;
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
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
    const out = (await git(["status", "--porcelain", "--untracked-files=no", "--", ".", ":!.factory/runs"], worktree))
      .stdout;
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
  }
  test(worktree: string, cmd: string) {
    return sh(["bash", "-c", cmd], worktree);
  }
}

// The proof's command: the top-level test gate, then the test gate of each package the change
// touches, run from that package's path. Without the package gates a monorepo change under
// packages/api is "proven" by tests that never load it.
export function proofCommand(
  gates: readonly GateSpec[],
  packages: readonly PackageSpec[],
  paths: readonly string[],
): string | undefined {
  const pkg = touchedPackages(packages, paths).flatMap((p) => {
    const g = testGate(p.gates);
    return g ? [`(cd '${p.path.replaceAll("'", "'\\''")}' && ${g.cmd})`] : [];
  });
  const all = [testGate(gates)?.cmd, ...pkg].filter((c): c is string => !!c);
  return all.length ? all.join(" && ") : undefined;
}

export interface PlanMutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly test: string;
}

// "unapplied": the find text is no longer in the file, which says nothing about the tests.
export interface MutationResult {
  readonly name: string;
  readonly status: "bites" | "survives" | "unapplied";
  readonly exitCode?: number;
  readonly tail: string;
}

export interface MutationIO {
  read(worktree: string, file: string): Promise<Buffer>;
  write(worktree: string, file: string, content: Buffer): Promise<void>;
  test(worktree: string, cmd: string): Promise<CommandResult>;
}

export function isMutation(m: unknown): m is PlanMutation {
  const o = m as Record<string, unknown> | null;
  return !!o && ["name", "file", "find", "replace", "test"].every((k) => typeof o[k] === "string");
}

// The file is put back from the bytes read, so a runner that throws still leaves the worktree
// as it found it. `cmdFor` turns a mutation's named test into the command to run.
export async function runMutations(
  io: MutationIO,
  worktree: string,
  mutations: readonly PlanMutation[],
  cmdFor: (test: string) => string = (test) => test,
): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  for (const m of mutations) {
    if (m.file.startsWith("/") || m.file.split("/").includes(".."))
      throw new Error(`mutation "${m.name}": ${m.file} is outside the repo`);
    const original = await io.read(worktree, m.file);
    const text = original.toString("utf8");
    const at = text.indexOf(m.find);
    if (at < 0) {
      results.push({ name: m.name, status: "unapplied", tail: `the find text is not in ${m.file}` });
      continue;
    }
    const mutated = text.slice(0, at) + m.replace + text.slice(at + m.find.length);
    try {
      await io.write(worktree, m.file, Buffer.from(mutated, "utf8"));
      const r = await io.test(worktree, cmdFor(m.test));
      const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-2000);
      results.push({ name: m.name, status: r.code === 0 ? "survives" : "bites", exitCode: r.code, tail });
    } finally {
      await io.write(worktree, m.file, original);
    }
  }
  return results;
}

export class ShellMutationIO implements MutationIO {
  async read(worktree: string, file: string) {
    return Buffer.from(await Bun.file(`${worktree}/${file}`).arrayBuffer());
  }
  async write(worktree: string, file: string, content: Buffer) {
    await Bun.write(`${worktree}/${file}`, content);
  }
  // A hung test must not leave the file mutated: killing it lets runMutations restore, and the
  // throw keeps a kill from reading as a test that bit.
  async test(worktree: string, cmd: string) {
    const proc = Bun.spawn(["bash", "-c", cmd], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, MUTATION_TEST_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) throw new Error(`the mutation's test ran past ${MUTATION_TEST_TIMEOUT_MS / 1000}s and was killed`);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  }
}

const MUTATION_TEST_TIMEOUT_MS = 300_000;
