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

// How a stage runs its agent inside a VM or container runtime (microsandbox, docker).
export interface AgentInVm {
  readonly argv: readonly string[];
  readonly cwd: string;
  // Folders besides cwd the agent reads or writes, such as the stage's scratch dir.
  readonly mounts: readonly string[];
  // What the guest sees. Only plain values: anything secret goes in spec.secrets.
  readonly env: Readonly<Record<string, string>>;
  // msb 0.7 does not forward piped stdin, so the prompt is read from this file in the guest.
  readonly stdinFile?: string;
  readonly name: string;
  // Per-run keys in spec.secrets' form, such as a stage's gateway key.
  readonly secrets?: readonly string[];
  // The worktree mounted read-only: an agent that leaves its process group still cannot write.
  readonly readOnly?: boolean;
  // Env var names a container reads from the client's env (its provider keys); msb uses `secrets`.
  readonly forward?: readonly string[];
}
