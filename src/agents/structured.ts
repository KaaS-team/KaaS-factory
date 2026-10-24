// Ported from owainlewis/machinist@3943516 internal/runner/codex_usage.go:41-435 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: returns the preset name with the command instead of a collector; the executor name is the agent's config name; nice is handled for claude only, as upstream does; Windows ".exe" and env's -S handling follow upstream.
// A config `command` that is really `codex exec` or `claude -p`, even behind
// env, mise or direnv, gets the JSON flag its preset parses. Anything not
// recognised is returned unchanged, so an odd command never gets a wrong flag.

export interface Structured {
  readonly preset: "codex" | "claude";
  readonly command: string[];
}

const base = (s: string): string => (s.split("/").pop() ?? s).toLowerCase().replace(/\.exe$/, "");
const named = (executor: string, tool: string): boolean =>
  executor
    .toLowerCase()
    .split(/[-_.]+/)
    .includes(tool);

// [recognized, takesNextValue]
type Opt = readonly [boolean, boolean];
const NO: Opt = [false, false];

function envShort(arg: string): Opt {
  if (arg.length < 2 || arg[0] !== "-" || arg[1] === "-") return NO;
  for (let i = 1; i < arg.length; i++) {
    const c = arg[i]!;
    if ("iv0".includes(c)) continue;
    if ("uCPSa".includes(c)) return [true, i + 1 === arg.length];
    return NO;
  }
  return [true, false];
}

function envSplitString(arg: string): boolean {
  if (arg.length < 2 || arg[0] !== "-" || arg[1] === "-") return false;
  for (const c of arg.slice(1)) {
    if ("iv0".includes(c)) continue;
    return c === "S";
  }
  return false;
}

function envProgramIndex(cmd: readonly string[]): number {
  for (let i = 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    if (a === "--") return i + 1 < cmd.length ? i + 1 : -1;
    if (a.includes("=") && !a.startsWith("-")) continue;
    if (
      a === "-" ||
      [
        "--ignore-environment",
        "--null",
        "--debug",
        "--block-signal",
        "--default-signal",
        "--ignore-signal",
        "--list-signal-handling",
      ].includes(a)
    )
      continue;
    if (envSplitString(a)) return -1;
    const [ok, next] = envShort(a);
    if (ok) {
      if (next) i++;
      continue;
    }
    if (a === "--split-string" || a.startsWith("--split-string=")) return -1;
    if (["--unset", "--chdir", "--argv0"].includes(a)) {
      i++;
      continue;
    }
    if (
      ["--unset=", "--chdir=", "--argv0=", "--block-signal=", "--default-signal=", "--ignore-signal="].some((p) =>
        a.startsWith(p),
      )
    )
      continue;
    if (a.startsWith("-")) return -1;
    return i;
  }
  return -1;
}

function miseGlobal(a: string): Opt {
  for (const o of ["--cd", "--env", "--jobs", "--output"]) {
    if (a === o) return [true, true];
    if (a.startsWith(`${o}=`)) return [true, false];
  }
  if (
    [
      "--quiet",
      "--verbose",
      "--yes",
      "--raw",
      "--locked",
      "--silent",
      "--no-config",
      "--no-env",
      "--no-hooks",
      "--help",
    ].includes(a)
  )
    return [true, false];
  if (a.length >= 2 && a[0] === "-" && a[1] !== "-") {
    for (let i = 1; i < a.length; i++) {
      const c = a[i]!;
      if ("qvyh".includes(c)) continue;
      if ("CEj".includes(c)) return [true, i + 1 === a.length];
      return NO;
    }
    return [true, false];
  }
  return NO;
}

function miseProgramIndex(cmd: readonly string[]): number {
  for (let i = 1; i < cmd.length; i++) {
    const [ok, next] = miseGlobal(cmd[i]!);
    if (ok) {
      if (next) i++;
      continue;
    }
    if (cmd[i] !== "exec" && cmd[i] !== "x") return -1;
    for (let j = i + 1; j < cmd.length; j++) if (cmd[j] === "--" && j + 1 < cmd.length) return j + 1;
    return -1;
  }
  return -1;
}

function direnvProgramIndex(cmd: readonly string[]): number {
  return cmd.length < 4 || cmd[1] !== "exec" || cmd[2] === "" || cmd[2]!.startsWith("-") ? -1 : 3;
}

function wrappedProgramIndex(cmd: readonly string[]): number {
  let at = 0;
  while (at < cmd.length) {
    let nested: number;
    switch (base(cmd[at]!)) {
      case "env":
        nested = envProgramIndex(cmd.slice(at));
        break;
      case "mise":
        nested = miseProgramIndex(cmd.slice(at));
        break;
      case "direnv":
        nested = direnvProgramIndex(cmd.slice(at));
        break;
      default:
        return at;
    }
    if (nested < 1) return -1;
    at += nested;
  }
  return -1;
}

function codexRoot(a: string): Opt {
  for (const o of [
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
  ]) {
    if (a === o) return [true, true];
    if (a.startsWith(`${o}=`) || (o.length === 2 && a.startsWith(o) && a.length > 2)) return [true, false];
  }
  return [
    "--strict-config",
    "--oss",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--not-so-yolo",
    "--search",
    "--no-alt-screen",
    "-h",
    "--help",
    "-V",
    "--version",
  ].includes(a)
    ? [true, false]
    : NO;
}

function codexExecAfter(cmd: readonly string[], program: number): number {
  for (let i = program + 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    const [ok, next] = codexRoot(a);
    if (ok) {
      if (next) i++;
      continue;
    }
    return a.startsWith("-") ? -1 : a === "exec" ? i : -1;
  }
  return -1;
}

function codexExecIndex(executor: string, cmd: readonly string[]): number {
  if (named(executor, "codex")) {
    for (let p = 0; p < cmd.length; p++)
      if (base(cmd[p]!) === "codex") {
        const at = codexExecAfter(cmd, p);
        if (at >= 0) return at;
      }
  }
  const program = wrappedProgramIndex(cmd);
  if (program < 0 || (base(cmd[program]!) !== "codex" && !named(executor, "codex"))) return -1;
  return codexExecAfter(cmd, program);
}

function claudeProgramIndex(cmd: readonly string[]): number {
  let p = wrappedProgramIndex(cmd);
  if (p >= 0 && base(cmd[p]!) === "nice") {
    p++;
    if (p >= cmd.length) return -1;
    if (cmd[p] === "-n" || cmd[p] === "--adjustment") p += 2;
    else if (cmd[p]!.startsWith("-n") || cmd[p]!.startsWith("--adjustment=")) p++;
    if (p >= cmd.length) return -1;
  }
  return p;
}

const CLAUDE_VALUE = [
  "--advisor",
  "--agent",
  "--agents",
  "--append-subagent-system-prompt",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--betas",
  "--debug-file",
  "--disallowedTools",
  "--dangerously-load-development-channels",
  "--disallowed-tools",
  "--effort",
  "--fallback-model",
  "--from-pr",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--max-turns",
  "--mcp-config",
  "--model",
  "--name",
  "-n",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--plugin-dir",
  "--plugin-url",
  "--session-id",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
  "--setting-sources",
  "--teammate-mode",
  "--tools",
  "--worktree",
  "-w",
];
const CLAUDE_BOOL = [
  "--allow-dangerously-skip-permissions",
  "--ax-screen-reader",
  "--bare",
  "--chrome",
  "--continue",
  "-c",
  "--dangerously-skip-permissions",
  "--disable-slash-commands",
  "--enable-auto-mode",
  "--exclude-dynamic-system-prompt-sections",
  "--debug",
  "--fork-session",
  "--forward-subagent-text",
  "--ide",
  "--include-hook-events",
  "--include-partial-messages",
  "--init",
  "--init-only",
  "--maintenance",
  "--no-chrome",
  "--no-session-persistence",
  "--print",
  "-p",
  "--replay-user-messages",
  "--restricted",
  "--safe-mode",
  "--strict-mcp-config",
  "--teleport",
  "--verbose",
];
const CLAUDE_VARIADIC = [
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--betas",
  "--disallowedTools",
  "--disallowed-tools",
  "--mcp-config",
  "--tools",
];
const claudeOptional = (a: string): boolean => a === "--resume" || a === "-r";

function claudeRoot(a: string): Opt {
  if (a === "--debug" || a.startsWith("--debug=")) return [true, false];
  if (claudeOptional(a) || CLAUDE_VARIADIC.includes(a)) return [true, false];
  for (const o of CLAUDE_VALUE) {
    if (a === o) return [true, true];
    if (a.startsWith(`${o}=`)) return [true, false];
  }
  if (CLAUDE_BOOL.includes(a)) return [true, false];
  if (a === "--prompt-suggestions" || a.startsWith("--prompt-suggestions=")) return [true, false];
  return NO;
}

interface ClaudeInfo {
  printIndex: number;
  hasOutputFormat: boolean;
  outputFormat: string;
  hasVerbose: boolean;
}

function claudeInfo(executor: string, cmd: readonly string[]): ClaudeInfo | undefined {
  const program = claudeProgramIndex(cmd);
  if (program < 0 || (base(cmd[program]!) !== "claude" && !named(executor, "claude"))) return undefined;
  const info: ClaudeInfo = { printIndex: -1, hasOutputFormat: false, outputFormat: "", hasVerbose: false };
  for (let i = program + 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    if (a === "--print" || a === "-p") {
      if (info.printIndex >= 0) return undefined;
      info.printIndex = i;
      continue;
    }
    if (a === "--" || !a.startsWith("-")) return undefined;
    const [ok, next] = claudeRoot(a);
    if (!ok) return undefined;
    if (a === "--output-format") {
      if (i + 1 >= cmd.length) return undefined;
      info.hasOutputFormat = true;
      info.outputFormat = cmd[++i]!;
    } else if (a.startsWith("--output-format=")) {
      info.hasOutputFormat = true;
      info.outputFormat = a.slice("--output-format=".length);
    } else if (a === "--verbose") info.hasVerbose = true;
    else if (claudeOptional(a)) {
      if (i + 1 < cmd.length && !cmd[i + 1]!.startsWith("-")) i++;
    } else if (CLAUDE_VARIADIC.includes(a)) {
      let v = i + 1;
      while (v < cmd.length && !cmd[v]!.startsWith("-")) v++;
      if (v === i + 1) return undefined;
      i = v - 1;
    } else if (next) {
      if (i + 1 >= cmd.length) return undefined;
      i++;
    }
  }
  return info.printIndex < 0 ? undefined : info;
}

export function structuredCommand(executor: string, command: readonly string[]): Structured | undefined {
  const exec = codexExecIndex(executor, command);
  if (exec >= 1) {
    const json = command.slice(exec + 1).includes("--json");
    return {
      preset: "codex",
      command: json ? [...command] : [...command.slice(0, exec + 1), "--json", ...command.slice(exec + 1)],
    };
  }
  const info = claudeInfo(executor, command);
  if (!info) return undefined;
  if (info.hasOutputFormat) {
    return info.outputFormat === "json" || info.outputFormat === "stream-json"
      ? { preset: "claude", command: [...command] }
      : undefined;
  }
  return {
    preset: "claude",
    command: [
      ...command.slice(0, info.printIndex + 1),
      ...(info.hasVerbose ? [] : ["--verbose"]),
      "--output-format",
      "stream-json",
      ...command.slice(info.printIndex + 1),
    ],
  };
}
