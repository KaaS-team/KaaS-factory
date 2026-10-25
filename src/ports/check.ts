// The repo's own gates: `.factory/gates.sh` today, run in a worktree and
// graded by its one FACTORY_GATES line, never by the agent.

export interface GateResult {
  readonly status: "GREEN" | "RED" | "MISCONFIGURED";
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failedGates: string[];
  readonly raw: string;
}

export interface GateRunner {
  run(worktreeDir: string): Promise<{ stdout: string; stderr: string; code: number }>;
}
