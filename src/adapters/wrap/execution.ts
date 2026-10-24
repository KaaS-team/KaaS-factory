// ExecutionPort through any launcher you name: a microVM (firecracker-ctr,
// an `fc` wrapper), podman, bubblewrap, nsjail. `argv` is the launcher's
// command line with "{cmd}" as the one element where the bash command goes;
// "{cwd}" anywhere is replaced by the worktree path. The launcher must make
// the worktree visible at that path and run `bash -c` on {cmd}'s element.

import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface WrapSpec {
  readonly kind: "wrap";
  readonly argv: readonly string[];
}

export const CMD = "{cmd}";

export function wrapArgs(spec: WrapSpec, cmd: string, cwd: string): string[] {
  return spec.argv.map((a) => (a === CMD ? cmd : a.replaceAll("{cwd}", cwd)));
}

export class WrapExecution implements ExecutionPort {
  constructor(private readonly spec: WrapSpec) {}
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    const proc = Bun.spawn(wrapArgs(this.spec, cmd, cwd), { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
}
