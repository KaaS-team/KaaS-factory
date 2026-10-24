// Ported from owainlewis/machinist@3943516 internal/runner/codex_usage_test.go:141-190 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the table is the Go table verbatim, generated from codex_usage_test.go and claude_usage_test.go:16-77,114-140; the collector-enabled assertions have no equivalent because the preset is chosen by structuredCommand.

import { expect, test } from "bun:test";
import { structuredCommand } from "../../../src/agents/structured";

const CODEX: [string, string, string[], string[]][] = [
  ["direct", "codex", ["codex", "exec", "-"], ["codex", "exec", "--json", "-"]],
  [
    "root option value matches subcommand",
    "codex",
    ["codex", "--profile", "exec", "exec", "-"],
    ["codex", "--profile", "exec", "exec", "--json", "-"],
  ],
  ["custom executor name", "codex-local", ["agent", "exec", "-"], ["agent", "exec", "--json", "-"]],
  ["wrapped", "custom", ["/usr/bin/env", "codex", "exec", "-"], ["/usr/bin/env", "codex", "exec", "--json", "-"]],
  [
    "wrapped renamed executable",
    "codex-local",
    ["/usr/bin/env", "agent", "exec", "-"],
    ["/usr/bin/env", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after diagnostic option",
    "codex-local",
    ["/usr/bin/env", "-v", "agent", "exec", "-"],
    ["/usr/bin/env", "-v", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after compact options",
    "codex-local",
    ["/usr/bin/env", "-iv", "agent", "exec", "-"],
    ["/usr/bin/env", "-iv", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after compact unset",
    "codex-local",
    ["/usr/bin/env", "-iuMISSING", "agent", "exec", "-"],
    ["/usr/bin/env", "-iuMISSING", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after argv zero",
    "codex-local",
    ["/usr/bin/env", "--argv0=codex", "agent", "exec", "-"],
    ["/usr/bin/env", "--argv0=codex", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after short argv zero",
    "codex-local",
    ["/usr/bin/env", "-a", "codex", "agent", "exec", "-"],
    ["/usr/bin/env", "-a", "codex", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapped renamed executable after empty environment alias",
    "codex-local",
    ["/usr/bin/env", "-", "agent", "exec", "-"],
    ["/usr/bin/env", "-", "agent", "exec", "--json", "-"],
  ],
  [
    "wrapper has its own exec",
    "custom",
    ["mise", "exec", "--", "codex", "exec", "-"],
    ["mise", "exec", "--", "codex", "exec", "--json", "-"],
  ],
  [
    "wrapper has global options",
    "custom",
    ["mise", "-q", "exec", "--", "codex", "exec", "-"],
    ["mise", "-q", "exec", "--", "codex", "exec", "--json", "-"],
  ],
  [
    "wrapper has compact global options",
    "custom",
    ["mise", "-qC/tmp", "exec", "--", "codex", "exec", "-"],
    ["mise", "-qC/tmp", "exec", "--", "codex", "exec", "--json", "-"],
  ],
  [
    "nested wrappers",
    "codex-local",
    ["env", "mise", "exec", "--", "codex", "exec", "-"],
    ["env", "mise", "exec", "--", "codex", "exec", "--json", "-"],
  ],
  [
    "reverse nested wrappers",
    "codex-local",
    ["mise", "exec", "--", "env", "agent", "exec", "-"],
    ["mise", "exec", "--", "env", "agent", "exec", "--json", "-"],
  ],
  [
    "direnv wrapper",
    "codex-local",
    ["direnv", "exec", ".", "codex", "exec", "-"],
    ["direnv", "exec", ".", "codex", "exec", "--json", "-"],
  ],
  [
    "direnv wrapper with renamed executable",
    "codex-local",
    ["direnv", "exec", ".", "agent", "exec", "-"],
    ["direnv", "exec", ".", "agent", "exec", "--json", "-"],
  ],
  ["nice wrapper", "codex-local", ["nice", "codex", "exec", "-"], ["nice", "codex", "exec", "--json", "-"]],
  [
    "automatic review root option",
    "codex",
    ["codex", "--approve-for-me", "exec", "-"],
    ["codex", "--approve-for-me", "exec", "--json", "-"],
  ],
  [
    "legacy automatic review root option",
    "codex",
    ["codex", "--not-so-yolo", "exec", "-"],
    ["codex", "--not-so-yolo", "exec", "--json", "-"],
  ],
  ["already structured", "codex", ["codex", "exec", "--json", "-"], ["codex", "exec", "--json", "-"]],
  ["other executor", "claude", ["claude", "exec", "-"], ["claude", "exec", "-"]],
  ["Codex words are data", "custom", ["echo", "codex", "exec"], ["echo", "codex", "exec"]],
  [
    "Codex words are env split string data",
    "custom",
    ["env", "-iSecho", "codex", "exec", "-"],
    ["env", "-iSecho", "codex", "exec", "-"],
  ],
  [
    "Codex words are long env split string data",
    "custom",
    ["env", "--split-string=echo", "codex", "exec", "-"],
    ["env", "--split-string=echo", "codex", "exec", "-"],
  ],
  [
    "Codex words are mise task arguments",
    "custom",
    ["mise", "run", "build", "--", "codex", "exec"],
    ["mise", "run", "build", "--", "codex", "exec"],
  ],
  ["other codex command", "codex", ["codex", "serve"], ["codex", "serve"]],
  ["exec argument to another Codex command", "codex", ["codex", "review", "exec"], ["codex", "review", "exec"]],
  [
    "unknown Codex root option",
    "codex",
    ["codex", "--future-option", "exec", "-"],
    ["codex", "--future-option", "exec", "-"],
  ],
];
const CLAUDE: [string, string, string[], string[]][] = [
  ["direct", "claude", ["claude", "--print"], ["claude", "--print", "--verbose", "--output-format", "stream-json"]],
  [
    "short print",
    "claude",
    ["claude", "-p", "--dangerously-skip-permissions"],
    ["claude", "-p", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"],
  ],
  [
    "renamed executable",
    "claude-local",
    ["agent", "--print"],
    ["agent", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "env wrapper",
    "custom",
    ["env", "claude", "--print"],
    ["env", "claude", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "mise wrapper",
    "custom",
    ["mise", "exec", "--", "claude", "--print"],
    ["mise", "exec", "--", "claude", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "nice wrapper",
    "custom",
    ["nice", "claude", "--print"],
    ["nice", "claude", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "nice long adjustment",
    "custom",
    ["nice", "--adjustment=5", "claude", "--print"],
    ["nice", "--adjustment=5", "claude", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "nice separate long adjustment",
    "custom",
    ["nice", "--adjustment", "5", "claude", "--print"],
    ["nice", "--adjustment", "5", "claude", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "max turns",
    "claude",
    ["claude", "--print", "--max-turns", "3"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--max-turns", "3"],
  ],
  [
    "bare resume",
    "claude",
    ["claude", "--resume", "--output-format=json", "--print"],
    ["claude", "--resume", "--output-format=json", "--print"],
  ],
  [
    "named resume",
    "claude",
    ["claude", "--resume", "session-name", "--print"],
    ["claude", "--resume", "session-name", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "variadic allowed tools",
    "claude",
    ["claude", "--print", "--allowedTools", "Bash", "Edit"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--allowedTools", "Bash", "Edit"],
  ],
  [
    "variadic add dirs",
    "claude",
    ["claude", "--add-dir", "../apps", "../lib", "--print"],
    ["claude", "--add-dir", "../apps", "../lib", "--print", "--verbose", "--output-format", "stream-json"],
  ],
  [
    "agent",
    "claude",
    ["claude", "--print", "--agent", "reviewer"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--agent", "reviewer"],
  ],
  [
    "strict MCP config",
    "claude",
    ["claude", "--print", "--strict-mcp-config"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--strict-mcp-config"],
  ],
  [
    "prompt suggestions flag",
    "claude",
    ["claude", "--print", "--prompt-suggestions"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--prompt-suggestions"],
  ],
  [
    "prompt suggestions separate value",
    "claude",
    ["claude", "--print", "--prompt-suggestions", "false"],
    ["claude", "--print", "--prompt-suggestions", "false"],
  ],
  [
    "prompt suggestions equals value",
    "claude",
    ["claude", "--print", "--prompt-suggestions=false"],
    ["claude", "--print", "--verbose", "--output-format", "stream-json", "--prompt-suggestions=false"],
  ],
  [
    "existing verbose",
    "claude",
    ["claude", "--print", "--verbose"],
    ["claude", "--print", "--output-format", "stream-json", "--verbose"],
  ],
  [
    "explicit text",
    "claude",
    ["claude", "--print", "--output-format", "text"],
    ["claude", "--print", "--output-format", "text"],
  ],
  [
    "explicit json",
    "claude",
    ["claude", "--output-format=json", "--print"],
    ["claude", "--output-format=json", "--print"],
  ],
  [
    "explicit stream json",
    "claude",
    ["claude", "--print", "--output-format", "stream-json"],
    ["claude", "--print", "--output-format", "stream-json"],
  ],
];
const REJECT: [string, string, string[]][] = [
  ["missing print", "claude", ["claude", "--verbose"]],
  ["prompt argument", "claude", ["claude", "--print", "prompt"]],
  ["short version option is not verbose", "claude", ["claude", "--print", "-v"]],
  ["unknown option", "claude", ["claude", "--future-option", "--print"]],
  ["missing option value", "claude", ["claude", "--print", "--model"]],
  ["missing variadic option value", "claude", ["claude", "--print", "--allowedTools"]],
  ["prompt suggestions optional value", "claude", ["claude", "--print", "--prompt-suggestions", "false"]],
  ["invalid output format", "claude", ["claude", "--print", "--output-format", "yaml"]],
  ["misleading data", "custom", ["echo", "claude", "--print"]],
  ["misleading data with Claude executor", "claude", ["echo", "claude", "--print"]],
  ["malformed env wrapper", "custom", ["env", "--split-string=claude --print"]],
];
test("Codex commands get --json, wrapped or not, and odd ones are left alone", () => {
  for (const [name, executor, command, want] of CODEX) {
    const before = [...command];
    const got = structuredCommand(executor, command);
    const isCodex = want.includes("--json") && want.includes("exec");
    expect(got ? got.command : command, name).toEqual(want.length ? want : command);
    if (got) expect(got.preset, name).toBe(executor === "claude" ? "claude" : "codex");
    else expect(isCodex && !command.includes("--json"), name).toBe(false);
    expect(command, `${name}: input mutated`).toEqual(before);
  }
});

test("Claude print commands get stream-json, and ambiguous ones are left alone", () => {
  for (const [name, executor, command, want] of CLAUDE) {
    const got = structuredCommand(executor, command);
    expect(got ? got.command : command, name).toEqual(want);
  }
  for (const [name, executor, command] of REJECT) expect(structuredCommand(executor, command), name).toBeUndefined();
});
