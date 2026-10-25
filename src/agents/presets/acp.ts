// Any Agent Client Protocol server: `command` is the server's argv, and src/agents/acp-bridge.ts
// drives it, taking the prompt on stdin and printing StageEvents. Read-only stages are held by the
// bridge refusing every permission request that is not a read, so they rely on the agent asking.

import { fileURLToPath } from "node:url";
import type { StageEvent } from "../../executor";
import { PROVIDER_KEYS } from "../env";
import { type AgentPreset, stagePolicy } from "../types";

const BRIDGE = fileURLToPath(new URL("../acp-bridge.ts", import.meta.url));
const KINDS = new Set(["tool_use", "text", "usage", "result"]);

export function parseAcpLine(line: string): StageEvent[] {
  try {
    const e = JSON.parse(line) as StageEvent;
    return e && KINDS.has(e.kind) ? [e] : [];
  } catch {
    return [];
  }
}

export const acpPreset: AgentPreset = {
  name: "acp",
  binary: "bun",
  verified: false,
  // The protocol version the bridge speaks; the agent's own version is whatever `command` runs.
  version: "1",
  envKeys: PROVIDER_KEYS,
  readOnlyBy: "the bridge refusing non-read permission requests",
  skillsDir: ".agents/skills",
  contextFile: "AGENTS.md",
  promptVia: "stdin",
  evidence: "docs/agent-research/acp/protocol.md:5",
  docker: false,
  returnsArtifact: true,
  wrapsCommand: true,
  command: (opts, agent, prompt) => ({
    argv: ["bun", BRIDGE, stagePolicy(opts.stage).write ? "write" : "read", opts.cwd, "--", ...(agent.command ?? [])],
    stdin: prompt,
  }),
  parseLine: parseAcpLine,
  isUsageCandidate: (line) => line.includes('"kind":"usage"'),
};
