// OpenCode: `opencode run --format json --auto --dir <cwd>` with the prompt on stdin.
// Events are `{type, part}`: `tool_use` parts name the tool, `step_finish` parts carry
// `tokens {input, output, cache {read, write}}`. Read-only stages use `--agent plan`, whose
// edit permission is deny-all, and return the artifact as the final message.

import type { StageEvent } from "../../executor";
import { type AgentPreset, stagePolicy } from "../types";
import { isUsageResultCandidate } from "../usage";

interface OpenCodeLine {
  type?: string;
  part?: {
    text?: string;
    tool?: string;
    tokens?: { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } };
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parseOpenCodeLine(line: string): StageEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: OpenCodeLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return isUsageResultCandidate(trimmed, "step_finish") ? [{ kind: "usage", invalid: true }] : [];
  }
  const part = parsed.part;
  if (parsed.type === "text" && part?.text) return [{ kind: "text", text: part.text, finalText: part.text }];
  if (parsed.type === "tool_use") return [{ kind: "tool_use", toolName: part?.tool ?? "tool" }];
  if (parsed.type === "step_finish") {
    const input = count(part?.tokens?.input);
    const output = count(part?.tokens?.output);
    const read = count(part?.tokens?.cache?.read ?? 0);
    const write = count(part?.tokens?.cache?.write ?? 0);
    if (input === null || output === null || read === null || write === null) return [{ kind: "usage", invalid: true }];
    return [{ kind: "usage", tokensIn: input + read + write, tokensOut: output, tokensCached: read }];
  }
  return [];
}

export const opencodePreset: AgentPreset = {
  name: "opencode",
  binary: "opencode",
  verified: false,
  version: "1.18.32",
  envKeys: [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
  ],
  readOnlyBy: "`--agent plan`",
  returnsArtifact: true,
  skillsDir: ".opencode/skills",
  contextFile: "AGENTS.md",
  promptVia: "stdin",
  evidence: "docs/agent-research/opencode/docs.md:5",
  command: (opts, agent, prompt) => ({
    argv: [
      "opencode",
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      opts.cwd,
      ...(stagePolicy(opts.stage).write ? [] : ["--agent", "plan"]),
      ...(agent.model ? ["-m", agent.model] : []),
    ],
    stdin: prompt,
  }),
  parseLine: parseOpenCodeLine,
  isUsageCandidate: () => false,
};
