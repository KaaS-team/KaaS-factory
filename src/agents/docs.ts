// docs/agents.md carries a table generated from PRESETS; tests/agents-registry.test.ts fails
// when the two disagree, and `bun scripts/gen-agents-doc.ts` rewrites it.

import { PRESETS } from "./presets";
import type { AgentConfig, StageAgents } from "./types";

export const TABLE_START = "<!-- agents-table:start -->";
export const TABLE_END = "<!-- agents-table:end -->";

export function agentsTable(): string {
  const rows = Object.values(PRESETS).map((p) =>
    [
      `\`${p.name}\``,
      `\`${p.binary}\``,
      `\`${p.version}\``,
      p.verified ? "yes" : "not yet",
      p.readOnlyBy,
      p.envKeys.map((k) => `\`${k}\``).join(", "),
      `\`${p.skillsDir}\``,
      p.docker === false ? "host only" : "pinned",
    ].join(" | "),
  );
  return [
    "Agent | Binary | Pinned version | Verified live | Read-only stages held by | API keys it may see | Skills dir | Docker",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...rows,
  ]
    .map((l) => `| ${l} |`)
    .join("\n");
}

export function renderAgentsDoc(doc: string): string {
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) throw new Error("docs/agents.md has no agents-table markers");
  return `${doc.slice(0, start + TABLE_START.length)}\n${agentsTable()}\n${doc.slice(end)}`;
}

const STAGE_NAMES = ["triage", "plan", "build", "verify", "pr", "retro"] as const;

export interface AgentRow {
  readonly name: string;
  readonly preset: string | null;
  readonly binary: string;
  readonly pin: string | null;
  readonly verified: boolean;
  readonly configured: boolean;
  readonly stages: readonly string[];
}

// One row per configured agent, then one per preset nobody has configured yet.
export function agentCatalog(agents: Readonly<Record<string, AgentConfig>>, stages: StageAgents): AgentRow[] {
  // A stage with no agent set runs on "claude", as the executor does.
  const serves = (name: string) => STAGE_NAMES.filter((s) => (stages[s] ?? stages.default ?? "claude") === name);
  const rows: AgentRow[] = Object.entries(agents).map(([name, cfg]) => {
    const preset = cfg.preset ? PRESETS[cfg.preset] : undefined;
    return {
      name,
      preset: cfg.preset ?? null,
      binary: preset?.binary ?? cfg.command?.[0] ?? name,
      pin: preset?.version ?? null,
      verified: preset?.verified ?? false,
      configured: true,
      stages: serves(name),
    };
  });
  const used = new Set(rows.map((r) => r.preset));
  for (const p of Object.values(PRESETS))
    if (!used.has(p.name))
      rows.push({
        name: p.name,
        preset: p.name,
        binary: p.binary,
        pin: p.version,
        verified: p.verified,
        configured: false,
        stages: [],
      });
  return rows;
}
