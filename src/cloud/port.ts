export type CloudStatus = "creating" | "running" | "finished" | "error" | "cancelled" | "expired";

export const TERMINAL: ReadonlySet<CloudStatus> = new Set(["finished", "error", "cancelled", "expired"]);

export interface LaunchInput {
  repoUrl: string;
  branch: string;
  prompt: string;
  model: string;
  key: string;
  title: string;
  // `owner/name#N`: the agent reads the issue body from this over REST.
  issueRef: string;
  // The issue's worktree, for a runtime that works on this machine.
  cwd?: string;
  // policy.push "agent": the agent pushes its own branch, so the runtime does not push again.
  agentPushes?: boolean;
}

export interface CloudRun {
  id: string;
  status: CloudStatus;
  prUrl?: string;
  summary?: string;
}

export interface CloudProvider {
  readonly name: string;
  launch(i: LaunchInput): Promise<CloudRun>;
  poll(id: string): Promise<CloudRun>;
  usage(id: string): Promise<{ costUsd?: number }>;
  steer(id: string, text: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export class CloudError extends Error {
  constructor(
    readonly kind: "auth" | "busy" | "rate_limited" | "not_found" | "provider",
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}
