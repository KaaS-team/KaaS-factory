// ExecutionPort on an lwpr build box: `lwpr run` packs the worktree (tracked
// and untracked, minus ignored), runs the command there in its own sandbox and
// mirrors the exit code. Its log merges both streams, so the command is framed.

import { framed, unframe } from "../../core/frame";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface LwprSpec {
  readonly kind: "lwpr";
  readonly app?: string;
  readonly timeoutMin?: number;
  // Run the repo's own lwpr `setup` first (default true).
  readonly setup?: boolean;
}

export function lwprArgs(spec: LwprSpec, cmd: string): string[] {
  return [
    "lwpr",
    "run",
    ...(spec.app ? ["--app", spec.app] : []),
    ...(spec.timeoutMin ? ["--timeout-min", String(spec.timeoutMin)] : []),
    ...(spec.setup === false ? ["--no-setup"] : []),
    "--",
    "bash",
    "-c",
    framed(cmd),
  ];
}

export class LwprExecution implements ExecutionPort {
  constructor(private readonly spec: LwprSpec = { kind: "lwpr" }) {}
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    const proc = Bun.spawn(lwprArgs(this.spec, cmd), { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return unframe(`${stdout}\n${stderr}`, code);
  }
}
