// Ported from owainlewis/skills@e8cadb3 internal/agents/agents.go:1-60 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the registry is built from PRESETS (each preset's skillsDir) plus upstream's hermes and agents entries, so a directory is written once; Go's New(overrides) becomes agentRegistry(overrides); no manifest parsing.

import { homedir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "./agents/presets";

export interface AgentDirs {
  readonly name?: string;
  readonly global?: string;
  readonly project?: string;
}

export type Scope = "global" | "project";

// Selected when an install names no agents (agents.go DefaultTargets).
export const DEFAULT_TARGETS = ["agents", "claude", "hermes"] as const;

function builtin(): Record<string, AgentDirs> {
  const m: Record<string, AgentDirs> = {
    hermes: { global: "~/.hermes/skills", project: ".hermes/skills" },
    agents: { global: "~/.agents/skills", project: ".agents/skills" },
  };
  for (const [name, p] of Object.entries(PRESETS)) m[name] = { global: `~/${p.skillsDir}`, project: p.skillsDir };
  return m;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// The dir an agent reads skills from: under the project root, or the user's home.
export function skillsDirFor(agent: AgentDirs, scope: Scope, projectRoot: string): string {
  return scope === "project" ? join(projectRoot, agent.project ?? "") : expandHome(agent.global ?? "");
}

// Built-ins merged with per-field overrides and additions.
export function agentRegistry(overrides: Record<string, AgentDirs> = {}): {
  get(name: string): (AgentDirs & { name: string }) | undefined;
} {
  const m = builtin();
  for (const [name, ov] of Object.entries(overrides))
    m[name] = {
      ...m[name],
      ...(ov.global ? { global: ov.global } : {}),
      ...(ov.project ? { project: ov.project } : {}),
    };
  return { get: (name) => (m[name] ? { ...m[name], name } : undefined) };
}
