// MCP servers a workflow step may load. `.factory/mcp.json` in the repo holds
// them in Claude Code's own `{ "mcpServers": { name: {...} } }` shape; a step's
// `mcp: [names]` picks which ones that step's agent starts with, and nothing
// else (the stage runs with --strict-mcp-config). Keep secrets out of the file:
// reference them as ${VAR}, which Claude Code expands from the stage's env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MCP_REGISTRY = ".factory/mcp.json";

export class McpError extends Error {}

export type McpServers = Readonly<Record<string, unknown>>;

interface Registry {
  readonly servers?: McpServers;
  readonly problem?: string;
}

// The registry's text, or undefined when the file does not exist.
export function parseMcpRegistry(text: string | undefined): Registry {
  if (text === undefined) return { problem: `${MCP_REGISTRY} not found` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { problem: `${MCP_REGISTRY} is not JSON: ${(e as Error).message}` };
  }
  const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { problem: `${MCP_REGISTRY}: needs an "mcpServers" object` };
  return { servers: servers as McpServers };
}

export function readRegistry(dir: string): Registry {
  const path = join(dir, MCP_REGISTRY);
  return parseMcpRegistry(existsSync(path) ? readFileSync(path, "utf8") : undefined);
}

// Every name the registry does not define, or why the registry cannot be read.
export function mcpProblems(registry: Registry, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const { servers, problem } = registry;
  if (problem) return [`${problem}, but a step names ${names.join(", ")}`];
  return names
    .filter((n) => !Object.hasOwn(servers!, n))
    .map((n) => `"${n}" is not in ${MCP_REGISTRY} (has: ${Object.keys(servers!).join(", ") || "none"})`);
}

// The subset of the registry one step asked for.
export function mcpServersFor(dir: string, names: readonly string[]): McpServers {
  const registry = readRegistry(dir);
  const problems = mcpProblems(registry, names);
  if (problems.length > 0) throw new McpError(problems.join("; "));
  const { servers } = registry;
  return Object.fromEntries(names.map((n) => [n, servers![n]]));
}
