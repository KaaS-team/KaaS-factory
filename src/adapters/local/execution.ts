// ExecutionPort on this machine: `bash -c` in the worktree, output captured.

import type { ExecResult, ExecutionPort } from "../../ports/execution";

export class LocalExecution implements ExecutionPort {
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
}
