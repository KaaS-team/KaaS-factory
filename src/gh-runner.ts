// The `gh` process runner. A call given timeoutMs is killed at that deadline and reported as timedOut.

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  // Set when the runner killed the call at opts.timeoutMs; code is 124 then.
  readonly timedOut?: boolean;
}

export interface CommandRunner {
  run(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult>;
}

export class GhCommandRunner implements CommandRunner {
  async run(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult> {
    const proc = Bun.spawn(["gh", ...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return timedOut ? { stdout, stderr, code: 124, timedOut: true } : { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  }
}
