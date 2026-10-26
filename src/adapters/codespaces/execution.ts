// ExecutionPort on a GitHub Codespace, through `gh codespace ssh` (a stopped codespace starts on
// connect). The worktree, without `.git` and `exclude`, goes as a tar.gz on the ssh's stdin, is
// unpacked into a fresh directory under `root`, `bash -c cmd` runs there, and the directory is removed.
// gh reads the token named by `tokenEnv` as GH_TOKEN, so it is never in an argv or machine.json.

import { shq } from "../../core/frame";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface CodespacesSpec {
  readonly kind: "codespaces";
  readonly codespace: string;
  readonly tokenEnv?: string;
  readonly root?: string;
  readonly exclude?: readonly string[];
}

// The remote script prints this before the command runs, so a run without it failed in gh or ssh.
export const READY = "factory-codespace: ready";

export function codespaceArgs(spec: CodespacesSpec, cmd: string, dir: string): { pack: string[]; run: string[] } {
  const excludes = [".git", ...(spec.exclude ?? ["node_modules"])].map((x) => `--exclude=./${x}`);
  const d = shq(dir);
  const script = [
    `mkdir -p ${d} && tar -xzf - -C ${d} || exit 97`,
    `echo ${shq(READY)} >&2`,
    `cd ${d} && bash -c ${shq(cmd)} < /dev/null`,
    "rc=$?",
    `cd / && rm -rf ${d}`,
    "exit $rc",
  ].join("\n");
  return {
    pack: ["tar", "-czf", "-", ...excludes, "."],
    // ssh joins its arguments into one remote shell line, so the script is one word.
    run: ["gh", "codespace", "ssh", "--codespace", spec.codespace, "--", `bash -c ${shq(script)}`],
  };
}

function fail(stderr: string): ExecResult {
  return { stdout: "", stderr, code: 1, runtimeFailed: stderr.split("\n")[0]! };
}

export class CodespacesExecution implements ExecutionPort {
  constructor(
    private readonly spec: CodespacesSpec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const where = `codespace ${this.spec.codespace}`;
    const env = { ...this.env };
    if (this.spec.tokenEnv) {
      const token = this.env[this.spec.tokenEnv];
      if (!token) return fail(`${where}: env var ${this.spec.tokenEnv} is not set`);
      env.GH_TOKEN = token;
    }
    const dir = `${this.spec.root ?? "/tmp/factory"}/${crypto.randomUUID()}`;
    const { pack, run } = codespaceArgs(this.spec, cmd, dir);
    const tar = Bun.spawn(pack, { cwd, stdout: "pipe", stderr: "pipe" });
    const [archive, tarErr, tarCode] = await Promise.all([
      new Response(tar.stdout).arrayBuffer(),
      new Response(tar.stderr).text(),
      tar.exited,
    ]);
    if (tarCode !== 0) return fail(`packing the worktree failed:\n${tarErr}`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(run, { cwd, env, stdin: new Uint8Array(archive), stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      return fail(`${where}: gh could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const stop = () => proc.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]).finally(() => signal?.removeEventListener("abort", stop));
    if (signal?.aborted) return fail(`${where}: cut off (${String(signal.reason)})`);
    const at = stderr.indexOf(`${READY}\n`);
    if (at < 0) return fail(`${where}: gh codespace ssh failed (exit ${code}):\n${stderr.slice(0, 2000)}`);
    return { stdout, stderr: stderr.slice(0, at) + stderr.slice(at + READY.length + 1), code };
  }
}
