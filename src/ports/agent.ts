// What runs one stage of an issue: an agent CLI (Claude Code, Codex, ...)
// behind a preset, or the replay executor the tests use.

import type { AgentCommands } from "../config";
import type { IssueScope } from "../core/model-tier";

export type StageName = "triage" | "plan" | "build" | "verify" | "pr" | "retro";

export interface StageEvent {
  readonly kind: "tool_use" | "text" | "usage" | "result" | "truncated" | "session" | "startup_error";
  readonly toolName?: string;
  // On "tool_use" events: the file, command or pattern the call touched, so a watcher can follow along.
  readonly toolTarget?: string;
  readonly text?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly tokensCached?: number;
  // On "usage" events: `total` means these are the run's final totals (replace
  // what was summed); `invalid` means the terminal event was unreadable, so
  // tokens are "not reported".
  readonly total?: boolean;
  readonly invalid?: boolean;
  readonly costUsd?: number;
  // On "result" events: tool calls the permission system refused, as "Tool path".
  readonly denials?: string[];
  // The agent's own closing message (Claude `result.result`, Codex `agent_message`).
  readonly finalText?: string;
  // On "session" events: the id `claude --resume` takes (factory takeover).
  readonly sessionId?: string;
}

export interface StageRunOptions {
  readonly stage: StageName;
  readonly issue: number;
  readonly cwd: string;
  // Paths the stage's agent must not read (src/acceptance.ts hiddenPaths); guard-paths.sh refuses them.
  readonly hiddenPaths?: readonly string[];
  readonly maxBudgetUsd: number;
  readonly timeoutMinutes?: number;
  readonly maxToolCalls?: number;
  readonly agentCommands?: AgentCommands;
  // The agent name from config; recorded in stage_runs. Unset means "claude".
  readonly agent?: string;
  // The issue's type label (e.g. "docs", or a repo-added type like "content"),
  // read from its GitHub labels. Unset on triage, which runs before the type
  // is known and so never routes on it (plan v2.7.0 item 1).
  readonly type?: string;
  // Rendered events are appended here as they arrive (the live view and the
  // local recording), and the live file names the running process for takeover.
  readonly transcriptFile?: string;
  readonly liveFile?: string;
  // A rebuild carries the tail of why it was sent back to every agent's prompt; an agent that
  // keeps sessions (the claude preset) also continues the last build's session.
  readonly resume?: { readonly sessionId?: string; readonly failure: string };
  // The MCP servers this run starts with, in .mcp.json's server shape. Absent: none.
  readonly mcp?: Readonly<Record<string, unknown>>;
  // A minion's whole prompt (src/engine/minion.ts), in place of the stage skill and the context
  // pack. `agent` (a minion's, or a workflow step's `agent:`) names the agent over the stage routing.
  readonly prompt?: string;
  // The issue's risk and size once triage or plan has judged them; picks the agent's model tier.
  readonly scope?: IssueScope;
  // Verify rejects so far on this issue; each one moves the build a model tier up.
  readonly rejects?: number;
}

// The killedReason a `factory takeover` stop gets. watch.ts parks on it
// instead of counting it as a failure.
export const OPERATOR_TAKEOVER = "operator takeover";

export interface StageRunResult {
  readonly events: StageEvent[];
  readonly toolCalls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached?: number;
  readonly costUsd: number;
  // True when the agent itself reported a cost; false means costFor decides.
  readonly costReported?: boolean;
  readonly exitCode: number;
  // Set when the runner killed the process itself (timeout or tool-call cap)
  // rather than letting it exit on its own — audit finding #15.
  readonly killedReason?: string;
  // The child's stderr, only set on a non-zero exit. `claude -p` prints its
  // launch-time errors (bad flag, auth, permission refusal) to stderr, not
  // stdout — before this, that stream was piped and never read, so a launch
  // failure surfaced as an empty result with no clue why.
  readonly stderrTail?: string;
  // Tool calls `claude` refused (from the result event's permission_denials).
  readonly permissionDenials: string[];
  // The agent's last message, capped at 16 KiB (machinist final_message.go).
  readonly finalMessage?: string;
  // False when an over-long event line or a missing parser meant tokens are
  // not a full count; the dashboard shows "Not reported" rather than zero.
  readonly usageComplete?: boolean;
  readonly agent?: string;
  readonly model?: string | null;
  // The agent's session, when its CLI reports one and keeps it resumable.
  readonly sessionId?: string;
}

export interface Executor {
  runStage(opts: StageRunOptions): Promise<StageRunResult>;
}
