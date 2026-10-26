import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCommands } from "./config";
import type { StageName } from "./executor";
import { safeCommands } from "./safe-outputs";

// Passed to `claude --settings`, which is not gated by workspace trust (the
// repo's own .claude/settings.json allow list is ignored under `-p`). Deny
// rules and the guard hook stay in the repo's settings and still apply.
const READ_ONLY_BASH = [
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git rev-parse *)",
  "Bash(git worktree list)",
  "Bash(cat *)",
  "Bash(ls *)",
  "Bash(grep *)",
  "Bash(find *)",
  "Bash(mkdir -p *)",
  "Bash(echo *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(diff *)",
  "Bash(pwd)",
];

const BUILD_EXTRA = [
  "Edit(**)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(.factory/gates.sh*)",
  "Bash(bash .factory/gates.sh*)",
];

// The verifier reverts the non-test hunks to prove the new test fails without
// them, then restores; the repo's deny list still blocks reset --hard and push.
// mutate.sh runs a plan's "removing X makes the tests fail" on a throwaway copy, so
// verify never needs Edit on the worktree it judges (#42).
const VERIFY_EXTRA = [
  "Bash(git stash *)",
  "Bash(git checkout *)",
  "Bash(git restore *)",
  "Bash(.factory/mutate.sh *)",
  "Bash(bash .factory/mutate.sh *)",
];

// What dontAsk refuses, measured on claude 2.1.289 (docs/decisions/stage-shell-shapes.md):
// &&, ; and pipes pass when every part is allowed. Subagents never see this
// text, so the template agents carry it verbatim (tests/skills.test.ts) and guard-paths.sh enforces it.
export const STAGE_GUIDANCE =
  "Shell rules for this stage: a command is refused if it writes a file with > or >> (>/dev/null and 2>&1 are fine), uses $(...), backticks or $?, uses brace expansion, or has cd or VAR=value at the start of the command or of any part after &&, ; or |. Commands already run in the repo root and the tool result shows the exit code. A refusal is about that one command, not Bash: rewrite it and carry on. To revert files use git restore --source=<ref> -- <files>.";

// Tools a stage never needs: they wait (ScheduleWakeup stalled #46), schedule,
// reach the operator's other sessions, or move the session off its worktree.
export const STAGE_DISALLOWED_TOOLS = [
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Monitor",
  "RemoteTrigger",
  "PushNotification",
  "SendMessage",
  "ListAgents",
  "Workflow",
  "EnterWorktree",
  "ExitWorktree",
] as const;

// The built-in tools each stage loads (`claude --tools`). Every tool definition rides every
// turn's input; on #95 the 13 default tools included WebSearch, NotebookEdit and DesignSync,
// which no stage used. Agent only where a skill dispatches one: plan's Explore and verify's
// factory-reviewer. Skill stays because the stage skills name factory-comment.
const BASE_TOOLS = ["Bash", "Read", "Write", "Skill"] as const;
export const STAGE_TOOLS: Record<StageName, readonly string[]> = {
  triage: BASE_TOOLS,
  plan: [...BASE_TOOLS, "Agent"],
  build: [...BASE_TOOLS, "Edit"],
  verify: [...BASE_TOOLS, "Edit", "Agent"],
  pr: BASE_TOOLS,
  retro: BASE_TOOLS,
};

const bash = (patterns: readonly string[]): string[] => patterns.map((p) => `Bash(${p})`);

// The repo's own commands (its test runner, its make targets) come from
// config.agentCommands, so nothing here assumes bun or make.
export function stageAllowRules(stage: StageName, issue: number, extra?: AgentCommands): string[] {
  const rules = [`Edit(.factory/runs/issue-${issue}/**)`, ...READ_ONLY_BASH, ...bash(safeCommands(extra?.read))];
  if (stage === "build") return [...rules, ...BUILD_EXTRA, ...bash(safeCommands(extra?.build))];
  if (stage === "verify") return [...rules, ...VERIFY_EXTRA, ...bash(safeCommands(extra?.verify))];
  return rules;
}

// The plugins a repo's .claude/settings.json or settings.local.json turns on. --setting-sources
// project,local still loads them, so a stage would run their hooks and pay for their skills (#88).
export function projectPlugins(cwd: string): string[] {
  const names = new Set<string>();
  for (const file of ["settings.json", "settings.local.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, ".claude", file), "utf8"));
      for (const [name, on] of Object.entries(parsed?.enabledPlugins ?? {})) if (on) names.add(name);
    } catch {
      // No file, or not JSON: Claude Code loads nothing from it either.
    }
  }
  return [...names];
}

// `mcp__<server>` allows every tool of a server the step named; under dontAsk an unlisted tool is denied.
// --settings outranks the project's own files, so `false` here keeps each project plugin out of the stage.
export function stageSettings(
  stage: StageName,
  issue: number,
  extra?: AgentCommands,
  mcpServers: readonly string[] = [],
  plugins: readonly string[] = [],
): string {
  return JSON.stringify({
    permissions: { allow: [...stageAllowRules(stage, issue, extra), ...mcpServers.map((s) => `mcp__${s}`)] },
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((p) => [p, false])) } : {}),
  });
}
