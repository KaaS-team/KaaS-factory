// Gemini CLI: `gemini -o stream-json --approval-mode <mode>` with the prompt on stdin.
// Shapes read from gemini-cli 0.61.0's docs and bundle (docs/agent-research/gemini/docs.md).
// Read-only stages run in `plan` mode and return their artifacts as the final message.

import type { StageEvent } from "../../executor";
import { type AgentPreset, stagePolicy } from "../types";
import { isUsageResultCandidate } from "../usage";

interface GeminiLine {
  type?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  stats?: { input_tokens?: unknown; output_tokens?: unknown; cached?: unknown };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// Assistant text arrives as deltas; the closing message is what it said after its last tool call.
export function createGeminiParser(): (line: string) => StageEvent[] {
  let closing = "";
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let parsed: GeminiLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return isUsageResultCandidate(trimmed, "result") ? [{ kind: "usage", invalid: true }] : [];
    }
    if (parsed.type === "message" && parsed.role === "assistant" && parsed.content) {
      closing += parsed.content;
      return [{ kind: "text", text: parsed.content }];
    }
    if (parsed.type === "tool_use") {
      closing = "";
      return [{ kind: "tool_use", toolName: parsed.tool_name ?? "tool" }];
    }
    if (parsed.type !== "result") return [];
    const tokensIn = count(parsed.stats?.input_tokens);
    const tokensOut = count(parsed.stats?.output_tokens);
    const events: StageEvent[] = closing ? [{ kind: "text", text: "", finalText: closing }] : [];
    if (tokensIn === null || tokensOut === null) return [...events, { kind: "usage", invalid: true }];
    return [
      ...events,
      { kind: "usage", tokensIn, tokensOut, tokensCached: count(parsed.stats?.cached) ?? 0, total: true },
    ];
  };
}

export const geminiPreset: AgentPreset = {
  name: "gemini",
  binary: "gemini",
  verified: false,
  version: "0.61.0",
  envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  readOnlyBy: "`--approval-mode plan`",
  skillsDir: ".gemini/skills",
  contextFile: "GEMINI.md",
  promptVia: "stdin",
  evidence: "docs/agent-research/gemini/docs.md:3",
  returnsArtifact: true,
  command: (opts, agent, prompt) => ({
    // Headless runs have no one to approve a tool call, so write stages use yolo.
    argv: [
      "gemini",
      "-o",
      "stream-json",
      "--approval-mode",
      stagePolicy(opts.stage).write ? "yolo" : "plan",
      ...(agent.model ? ["-m", agent.model] : []),
      "-p",
      "",
    ],
    stdin: prompt,
  }),
  parseLine: (line) => createGeminiParser()(line),
  newParser: createGeminiParser,
  isUsageCandidate: (line) => isUsageResultCandidate(line, "result"),
};
