// CLI tools a repo declares for a workflow's `cli` step. `.factory/cli-tools.json` in the base
// checkout lists each by name, command and expected output:
//   { "tools": { "lint": { "command": "bun", "args": ["run", "lint"], "expect": "0 errors" } } }
// A step can call only a declared name. The command runs with no shell, so an argument is one argv
// entry, and with only PATH, HOME, TMPDIR, LANG and the variable names the declaration lists, never a
// runner token (the same filter an MCP tool server gets).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolEnv } from "./mcp-call";

export const CLI_TOOLS_FILE = ".factory/cli-tools.json";
const NAME = /^[\w-]{1,64}$/;
const KEYS = new Set(["command", "args", "expect", "env"]);

export class CliToolError extends Error {}

export interface CliTool {
  readonly command: string;
  readonly args: readonly string[];
  // Text the tool's stdout must contain; unset checks only the exit code.
  readonly expect?: string;
  // Env var names the tool may read from the runner's environment, after the secret filter.
  readonly env: readonly string[];
}

export interface CliResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  // Why ok is false, in one line.
  readonly reason?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function cliToolProblems(raw: unknown): string[] {
  if (!isObj(raw) || !isObj(raw.tools)) return [`${CLI_TOOLS_FILE}: needs a "tools" object`];
  const problems: string[] = [];
  for (const [name, t] of Object.entries(raw.tools)) {
    const where = `${CLI_TOOLS_FILE}: tools.${name}`;
    if (!NAME.test(name)) problems.push(`${where}: a tool name is letters, digits, _ and -, up to 64`);
    if (!isObj(t)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    for (const k of Object.keys(t))
      if (!KEYS.has(k)) problems.push(`${where}.${k}: unknown key (allowed: ${[...KEYS].join(", ")})`);
    if (typeof t.command !== "string" || !t.command.trim()) problems.push(`${where}.command: required`);
    if (t.args !== undefined && !strings(t.args)) problems.push(`${where}.args: must be a list of strings`);
    if (t.expect !== undefined && typeof t.expect !== "string") problems.push(`${where}.expect: must be a string`);
    if (t.env !== undefined && !(strings(t.env) && t.env.every((e) => /^[A-Za-z_]\w*$/.test(e))))
      problems.push(`${where}.env: must be a list of env var names`);
  }
  return problems;
}

export function readCliTools(dir: string): Record<string, CliTool> {
  const path = join(dir, CLI_TOOLS_FILE);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliToolError(`${CLI_TOOLS_FILE} is not JSON: ${(e as Error).message}`);
  }
  const problems = cliToolProblems(raw);
  if (problems.length > 0) throw new CliToolError(problems.join("; "));
  const out: Record<string, CliTool> = Object.create(null);
  for (const [name, t] of Object.entries((raw as { tools: Record<string, Record<string, unknown>> }).tools))
    out[name] = {
      command: t.command as string,
      args: (t.args as string[] | undefined) ?? [],
      ...(t.expect === undefined ? {} : { expect: t.expect as string }),
      env: (t.env as string[] | undefined) ?? [],
    };
  return out;
}

// The declared tool, or an error that names the one asked for.
export function declaredCliTool(dir: string, name: string): CliTool {
  const tools = readCliTools(dir);
  const tool = tools[name];
  if (!tool)
    throw new CliToolError(
      `cli tool "${name}" is not declared in ${CLI_TOOLS_FILE} (declared: ${Object.keys(tools).join(", ") || "none"})`,
    );
  return tool;
}

export async function runCliTool(
  dir: string,
  name: string,
  extraArgs: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 60_000,
): Promise<CliResult> {
  const tool = declaredCliTool(dir, name);
  const { vars, child } = toolEnv(env, tool.env);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([tool.command, ...tool.args, ...extraArgs], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...child, ...vars },
    });
  } catch (e) {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: "",
      reason: `could not start \`${tool.command}\`: ${(e as Error).message}`,
    };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (code !== 0) return { ok: false, code, stdout, stderr, reason: `exited ${code}` };
    if (tool.expect !== undefined && !stdout.includes(tool.expect))
      return { ok: false, code, stdout, stderr, reason: `output did not contain ${JSON.stringify(tool.expect)}` };
    return { ok: true, code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
