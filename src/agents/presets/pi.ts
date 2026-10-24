// Pi: `pi -p --mode json --no-session` with the prompt on stdin. Events are from
// pi's docs/json.md; usage is on each assistant message_end (pi-ai `Usage`), so it is summed.
// Read-only stages get a read-only tool allow-list and return their artifacts as the final message.

import type { StageEvent } from "../../executor";
import { type AgentPreset, stagePolicy } from "../types";
import { isUsageResultCandidate } from "../usage";

interface PiLine {
  type?: string;
  toolName?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parsePiLine(line: string): StageEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: PiLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return isUsageResultCandidate(trimmed, "message_end") ? [{ kind: "usage", invalid: true }] : [];
  }
  if (parsed.type === "tool_execution_start") return [{ kind: "tool_use", toolName: parsed.toolName ?? "tool" }];
  if (parsed.type !== "message_end" || parsed.message?.role !== "assistant") return [];
  const events: StageEvent[] = [];
  const text = (parsed.message.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
  if (text) events.push({ kind: "text", text, finalText: text });
  const u = parsed.message.usage;
  const input = count(u?.input);
  const output = count(u?.output);
  const read = count(u?.cacheRead ?? 0);
  const write = count(u?.cacheWrite ?? 0);
  if (input === null || output === null || read === null || write === null)
    events.push({ kind: "usage", invalid: true });
  else events.push({ kind: "usage", tokensIn: input + read + write, tokensOut: output, tokensCached: read });
  return events;
}

export const piPreset: AgentPreset = {
  name: "pi",
  binary: "pi",
  verified: false,
  version: "0.73.1",
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
  readOnlyBy: "`--tools read,grep,find,ls`",
  skillsDir: ".pi/skills",
  contextFile: "AGENTS.md",
  promptVia: "stdin",
  evidence: "docs/agent-research/pi/stdin.md:5",
  returnsArtifact: true,
  command: (opts, agent, prompt) => ({
    argv: [
      "pi",
      "-p",
      "--mode",
      "json",
      "--no-session",
      ...(stagePolicy(opts.stage).write ? [] : ["--tools", "read,grep,find,ls"]),
      ...(agent.model ? ["--model", agent.model] : []),
    ],
    stdin: prompt,
  }),
  parseLine: parsePiLine,
  isUsageCandidate: () => false,
};
