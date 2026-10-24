// `factory takeover N`: stop the issue's running stage (if any), open its
// agent session in the worktree, and hand the issue back when the operator
// exits. The pieces with no terminal are here so they are testable.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentConfig } from "./agents/types";
import { takeoverMarker } from "./paths";

export interface LiveStage {
  readonly pid: number;
  readonly issue: number;
  readonly stage: string;
  readonly agent: string;
  readonly sessionId?: string;
  readonly transcriptFile?: string;
}

export function readLive(liveFile: string): LiveStage | undefined {
  try {
    return JSON.parse(readFileSync(liveFile, "utf8")) as LiveStage;
  } catch {
    return undefined;
  }
}

// Marks the stop as a takeover, then SIGTERMs the stage's process group and
// waits for the executor to remove the live file. False if it never did.
export async function stopRunningStage(liveFile: string, live: LiveStage, timeoutMs = 60_000): Promise<boolean> {
  writeFileSync(takeoverMarker(liveFile), "");
  try {
    process.kill(-live.pid, "SIGTERM");
  } catch {
    // Already gone: the executor's exit path still clears the files.
  }
  const end = Date.now() + timeoutMs;
  while (existsSync(liveFile)) {
    if (Date.now() > end) {
      rmSync(takeoverMarker(liveFile), { force: true });
      return false;
    }
    await Bun.sleep(200);
  }
  return true;
}

// Only Claude sessions can be reopened today; any other agent is refused by name.
export function resumeArgv(
  agentName: string,
  agents: Readonly<Record<string, AgentConfig>>,
  sessionId: string,
): string[] {
  const preset = agents[agentName]?.preset ?? (agentName === "claude" ? "claude" : undefined);
  if (preset !== "claude")
    throw new Error(`agent ${agentName} cannot be resumed: only the claude preset keeps a session`);
  return ["claude", "--resume", sessionId];
}

// What takeover prints before handing the terminal to the agent. A fresh
// worktree is a folder Claude has not seen, so it asks to trust it first.
export function takeoverBanner(argv: readonly string[], worktree: string): string[] {
  return [
    `factory takeover: ${argv.join(" ")}  (in ${worktree}; exit to hand back)`,
    "factory takeover: Claude will ask to trust this worktree: choose Yes",
  ];
}
