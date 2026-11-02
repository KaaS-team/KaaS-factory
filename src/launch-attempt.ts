// A closed set of launch outcomes, so the scheduler can pick a next action per outcome
// instead of reading one free-text failure string.

export type LaunchOutcome =
  | "started"
  | "rate_limited"
  | "concurrency_limited"
  | "environment_gone"
  | "agent_gone"
  | "stopped_unexpectedly";

export interface LaunchAction {
  readonly do: "none" | "requeue" | "pause_runtime" | "fail";
  readonly delayMs?: number;
}

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const MAX_ATTEMPTS = 3;

const MATCHERS: readonly (readonly [LaunchOutcome, readonly string[]])[] = [
  ["rate_limited", ["rate limit", "rate-limit", "too many requests", "429"]],
  ["concurrency_limited", ["concurrency", "concurrent", "no free slot", "slot limit"]],
  ["environment_gone", ["sandbox not found", "sandbox is gone", "sandbox was deleted", "environment not found"]],
  ["agent_gone", ["agent not found", "agent is gone", "agent exited", "agent disconnected"]],
];

export function classifyLaunch(res: { runtimeFailed?: string; exitCode?: number }): LaunchOutcome {
  const text = res.runtimeFailed?.toLowerCase();
  if (!text) return res.exitCode === undefined || res.exitCode === 0 ? "started" : "stopped_unexpectedly";
  for (const [outcome, needles] of MATCHERS) if (needles.some((n) => text.includes(n))) return outcome;
  return "stopped_unexpectedly";
}

// `attempt` counts from 1.
export function nextAction(outcome: LaunchOutcome, attempt: number): LaunchAction {
  switch (outcome) {
    case "started":
      return { do: "none" };
    case "rate_limited":
      return { do: "requeue", delayMs: Math.min(BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_MS) };
    case "concurrency_limited":
      return { do: "pause_runtime" };
    case "environment_gone":
    case "agent_gone":
      return { do: "requeue" };
    case "stopped_unexpectedly":
      return attempt >= MAX_ATTEMPTS ? { do: "fail" } : { do: "requeue" };
  }
}
