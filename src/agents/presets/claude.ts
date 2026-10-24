// Claude Code: `claude -p /factory-<stage> N` with stream-json output. The argv
// is pinned byte for byte by tests/agents.test.ts; the repo's own skill is the
// prompt, so this preset ignores the rendered one.
// Flags checked against `claude --help` on 2026-10-05 (2.1.289), --effort and --tools included.

import type { StageEvent, StageName, StageRunOptions } from "../../executor";
import { STAGE_DISALLOWED_TOOLS, STAGE_GUIDANCE, STAGE_TOOLS, stageSettings } from "../../stage-permissions";
import type { AgentPreset } from "../types";
import { isUsageResultCandidate, readUsage } from "../usage";

// One line of Claude Code's --output-format stream-json. Only the fields this
// runner needs; the real stream carries more.
interface StreamJsonLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: unknown;
  permission_denials?: Array<{ tool_name?: string; tool_input?: { file_path?: string; command?: string } }>;
  // On the init event. A server that could not start reports status "failed"
  // (seen on 2.1.294); the *_errors arrays are absent when nothing failed.
  mcp_servers?: Array<{ name?: string; status?: string }>;
  plugin_errors?: unknown[];
  mcp_server_errors?: unknown[];
}

// What on the init event means the stage started without the setup it asked for.
function startupProblems(init: StreamJsonLine): string[] {
  const failed = (init.mcp_servers ?? [])
    .filter((s) => s.status === "failed")
    .map((s) => `MCP server ${s.name ?? "?"} failed to start`);
  const errors = [...(init.plugin_errors ?? []), ...(init.mcp_server_errors ?? [])].map((e) =>
    typeof e === "string" ? e : JSON.stringify(e),
  );
  return [...failed, ...errors];
}

// The one field a person watching needs from a call's input; first line only, never the whole payload.
const TARGET_KEYS = ["file_path", "command", "pattern", "skill", "path", "url", "query"] as const;
export function toolTarget(input: Record<string, unknown> | undefined): string | undefined {
  const value = TARGET_KEYS.map((k) => input?.[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (!value) return undefined;
  return value.trim().split("\n")[0]!;
}

export function parseStreamJsonLine(line: string): StageEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A cut-off final result means the totals cannot be trusted.
    return isUsageResultCandidate(trimmed, "result") ? [{ kind: "usage", invalid: true }] : [];
  }
  const events: StageEvent[] = [];

  if (parsed.type === "system" && parsed.subtype === "init") {
    if (parsed.session_id) events.push({ kind: "session", sessionId: parsed.session_id, text: parsed.session_id });
    for (const problem of startupProblems(parsed)) events.push({ kind: "startup_error", text: problem });
  } else if (parsed.type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === "text" && block.text) {
        events.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        const target = toolTarget(block.input);
        events.push(
          target
            ? { kind: "tool_use", toolName: block.name, toolTarget: target }
            : { kind: "tool_use", toolName: block.name },
        );
      }
    }
    if (parsed.message.usage) {
      events.push({
        kind: "usage",
        tokensIn: parsed.message.usage.input_tokens ?? 0,
        tokensOut: parsed.message.usage.output_tokens ?? 0,
      });
    }
  } else if (parsed.type === "result") {
    const denials = (parsed.permission_denials ?? []).map((d) =>
      `${d.tool_name ?? "tool"} ${d.tool_input?.file_path ?? d.tool_input?.command ?? ""}`.trim(),
    );
    // Cumulative usage incl. cache tokens (machinist codex_usage.go); a result with no usage keeps the per-message sums.
    if (parsed.usage !== undefined) {
      const usage = readUsage(parsed.usage, true);
      events.push(
        usage
          ? {
              kind: "usage",
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              tokensCached: usage.tokensCached,
              total: true,
            }
          : { kind: "usage", invalid: true },
      );
    }
    events.push({
      kind: "result",
      ...((parsed.total_cost_usd ?? parsed.cost_usd) === undefined
        ? {}
        : { costUsd: parsed.total_cost_usd ?? parsed.cost_usd }),
      text: parsed.subtype,
      ...(denials.length ? { denials } : {}),
      ...(parsed.result ? { finalText: parsed.result } : {}),
    });
  }
  return events;
}

// `contextPack` (buildContextPack, plan v2.7.0 item 3) rides the same
// --append-system-prompt as STAGE_GUIDANCE, appended after it. --help gives
// no guarantee that repeating the flag concatenates rather than overriding,
// so this sends one flag with one value rather than risk losing STAGE_GUIDANCE.
export function claudeArgs(opts: StageRunOptions, contextPack = "", mcpConfig?: string): string[] {
  const command = opts.prompt ?? `/factory-${opts.stage} ${opts.issue}`;
  return [
    "-p",
    opts.resume ? `${command}\n\nThe last attempt was sent back. The tail of why:\n\n${opts.resume.failure}` : command,
    // A fork keeps the earlier attempt's context but records this one under its own session id.
    ...(opts.resume ? ["--resume", opts.resume.sessionId, "--fork-session"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "project,local",
    // Only the servers the step named; with none, no server at all. Without
    // --strict-mcp-config the operator's claude.ai connectors (Gmail, Drive) load too.
    ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
    "--strict-mcp-config",
    "--disallowedTools",
    STAGE_DISALLOWED_TOOLS.join(","),
    "--tools",
    STAGE_TOOLS[opts.stage].join(","),
    "--settings",
    stageSettings(opts.stage, opts.issue, opts.agentCommands, Object.keys(opts.mcp ?? {})),
    "--append-system-prompt",
    contextPack ? `${STAGE_GUIDANCE}\n\n${contextPack}` : STAGE_GUIDANCE,
    "--max-budget-usd",
    String(opts.maxBudgetUsd),
  ];
}

// The one place a stage's model and effort default. The stages that only classify or
// fill a template run on sonnet at low effort; plan, build and verify keep the CLI's
// default model and effort. A configured `model` replaces the stage's model.
export const CLAUDE_STAGE_DEFAULTS: Record<StageName, { model?: string; effort?: "low" | "medium" | "high" }> = {
  triage: { model: "sonnet", effort: "low" },
  plan: {},
  build: {},
  verify: {},
  pr: { model: "sonnet", effort: "low" },
  retro: { model: "sonnet", effort: "low" },
};

export function claudeModelArgs(stage: StageName, configured?: string): string[] {
  const { model, effort } = CLAUDE_STAGE_DEFAULTS[stage];
  const chosen = configured ?? model;
  return [...(chosen ? ["--model", chosen] : []), ...(effort ? ["--effort", effort] : [])];
}

export const claudePreset: AgentPreset = {
  name: "claude",
  binary: "claude",
  verified: true,
  version: "2.1.286",
  envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  // A headless stage has no one to resume a background task for, and no reason to phone home.
  env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  readOnlyBy: "the stage allow-list under `dontAsk`",
  skillsDir: ".claude/skills",
  contextFile: "CLAUDE.md",
  ownsPrompt: true,
  // `prompt` is the context pack for an ownsPrompt agent: Claude runs its own
  // skill and ignores everything else spawnStage would otherwise put there.
  mcp: true,
  command: (opts, agent, prompt, ctx) => ({
    argv: ["claude", ...claudeArgs(opts, prompt, ctx?.mcpConfig), ...claudeModelArgs(opts.stage, agent.model)],
  }),
  parseLine: parseStreamJsonLine,
  isUsageCandidate: (line) => isUsageResultCandidate(line, "result"),
};
