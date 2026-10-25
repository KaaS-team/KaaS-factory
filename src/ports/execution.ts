// Where a step's shell command runs. The local adapter is a bash child of
// this process; a docker, ssh or hosted-sandbox adapter (v3.3) implements
// the same call, so setup, gates and check steps never know which.

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  // Set when the runtime failed before or around the command (unreachable,
  // refused, cut off), so a caller can tell that from the command failing.
  readonly runtimeFailed?: string;
}

export interface ExecutionPort {
  // `cmd` is a bash command line, run with `cwd` as its working directory.
  // An adapter that honours `signal` stops the command when it aborts.
  run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
}
