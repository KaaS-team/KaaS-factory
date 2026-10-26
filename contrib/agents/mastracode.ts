// Mastra Code (Apache-2.0, Kepler Software, Inc.): `mastracode -o jsonl --permission-mode auto`, prompt on
// stdin. Each line is an AgentController event, shaped per @mastra/code-sdk's types (nothing from `ee/`).
// Exit code 2 means the --timeout expired. Read-only stages use `--mode plan`.

import type { StageEvent } from "../../src/executor";
import { type AgentPreset, stagePolicy } from "../../src/agents/types";
import { isUsageResultCandidate } from "../../src/agents/usage";
import { mastraArgv } from "./mastracode-flags";

interface MastraLine {
  type?: string;
  id?: string;
  toolName?: string;
  message?: { id?: string; role?: string };
  event?: { type?: string; delta?: string };
  usage?: { promptTokens?: unknown; completionTokens?: unknown };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// Text arrives as deltas; the closing message is what the assistant said last.
export function createMastraParser(): (line: string) => StageEvent[] {
  let assistantId: string | undefined;
  let buffer = "";
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let parsed: MastraLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return isUsageResultCandidate(trimmed, "usage_update") ? [{ kind: "usage", invalid: true }] : [];
    }
    switch (parsed.type) {
      case "message_start":
        if (parsed.message?.role !== "assistant") return [];
        assistantId = parsed.message.id;
        buffer = "";
        return [];
      case "message_update":
        if (parsed.id === assistantId && parsed.event?.type === "text-delta" && parsed.event.delta)
          buffer += parsed.event.delta;
        return [];
      case "message_end": {
        if (parsed.id !== assistantId || !buffer) return [];
        const text = buffer;
        buffer = "";
        return [{ kind: "text", text, finalText: text }];
      }
      case "tool_start":
        return [{ kind: "tool_use", toolName: parsed.toolName ?? "tool" }];
      case "usage_update": {
        const tokensIn = count(parsed.usage?.promptTokens);
        const tokensOut = count(parsed.usage?.completionTokens);
        return tokensIn === null || tokensOut === null
          ? [{ kind: "usage", invalid: true }]
          : [{ kind: "usage", tokensIn, tokensOut, total: true }];
      }
      default:
        return [];
    }
  };
}

export const mastracodePreset: AgentPreset = {
  name: "mastracode",
  binary: "mastracode",
  verified: false,
  version: "0.42.0",
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
  readOnlyBy: "`--mode plan`",
  skillsDir: ".mastracode/skills",
  contextFile: "AGENTS.md",
  promptVia: "stdin",
  evidence: "docs/agent-research/mastracode/docs.md:5",
  noVersionFlag: true,
  returnsArtifact: true,
  command: (opts, agent, prompt) => ({
    argv: [
      "mastracode",
      ...mastraArgv({
        "permission-mode": "auto",
        output: "jsonl",
        mode: stagePolicy(opts.stage).write ? "build" : "plan",
        timeout: opts.timeoutMinutes ? String(opts.timeoutMinutes * 60) : undefined,
        model: agent.model,
      }),
    ],
    stdin: prompt,
  }),
  parseLine: (line) => createMastraParser()(line),
  newParser: createMastraParser,
  isUsageCandidate: (line) => isUsageResultCandidate(line, "usage_update"),
};
