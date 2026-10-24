// Cursor Agent: `cursor-agent -p --output-format stream-json --force --workspace <cwd> <prompt>`.
// The CLI documents no stdin prompt, so the prompt is the last argument. stream-json
// reports no token usage in 2026.01.23, so usage stays "not reported". Read-only
// stages run with `--mode plan` and return their artifacts as the final message.

import type { StageEvent } from "../../executor";
import { type AgentPreset, stagePolicy } from "../types";

interface CursorLine {
  type?: string;
  subtype?: string;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  tool_call?: Record<string, unknown>;
}

export function parseCursorLine(line: string): StageEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: CursorLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed.type === "assistant") {
    const text = (parsed.message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
    return text ? [{ kind: "text", text }] : [];
  }
  if (parsed.type === "tool_call" && parsed.subtype === "started") {
    const key = Object.keys(parsed.tool_call ?? {})[0] ?? "tool";
    return [{ kind: "tool_use", toolName: key.replace(/ToolCall$/, "") }];
  }
  if (parsed.type === "result" && parsed.result)
    return [{ kind: "text", text: parsed.result, finalText: parsed.result }];
  return [];
}

export const cursorPreset: AgentPreset = {
  name: "cursor",
  binary: "cursor-agent",
  verified: false,
  version: "2026.01.23-916f423",
  envKeys: ["CURSOR_API_KEY"],
  readOnlyBy: "`--mode plan`",
  skillsDir: ".cursor/skills",
  contextFile: "AGENTS.md",
  promptVia: "argv",
  evidence: "docs/agent-research/cursor/docs.md:5",
  // Cursor's installer has no versioned download URL, so the Docker image cannot pin it.
  docker: false,
  returnsArtifact: true,
  command: (opts, agent, prompt) => ({
    argv: [
      "cursor-agent",
      "-p",
      "--output-format",
      "stream-json",
      "--workspace",
      opts.cwd,
      ...(stagePolicy(opts.stage).write ? ["--force"] : ["--mode", "plan"]),
      ...(agent.model ? ["--model", agent.model] : []),
      prompt,
    ],
  }),
  parseLine: parseCursorLine,
  isUsageCandidate: () => false,
};
