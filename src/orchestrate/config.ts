// Resolved orchestrate settings: cloud agent caps, grooming, priority and spend limits.
import type { OrchestrateSpec as OrchestrateSpecBase } from "./types";
import { orchestrateProblems as orchestrateProblemsInner } from "./problems";
import { expandPreset, type OrchestratePreset, PRESET_NAMES } from "./presets";
import { resolveOrchestrate as resolveOrchestrateInner } from "./resolve";

export type { Orchestrate, PriorityRule, Provider, ProviderSpec } from "./types";
export type OrchestrateSpec = OrchestrateSpecBase & { preset?: OrchestratePreset };
export type { OrchestratePreset } from "./presets";
export { DEFAULT_ORCHESTRATE, PRIORITY_RULES } from "./types";
export { PRESETS, expandPreset } from "./presets";

import type { Orchestrate } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stripPreset(raw: Record<string, unknown>): Record<string, unknown> {
  const { preset: _p, ...rest } = raw;
  return rest;
}

export function orchestrateProblems(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return orchestrateProblemsInner(raw, where);
  const out = orchestrateProblemsInner(stripPreset(raw), where);
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== "string" || !PRESET_NAMES.includes(raw.preset as OrchestratePreset))
      out.push(`${where}.preset: expected one of ${PRESET_NAMES.join(", ")}`);
  }
  return out;
}

function expandLevel(slice: unknown): OrchestrateSpec | undefined {
  if (slice === undefined) return undefined;
  return expandPreset(slice as OrchestrateSpec);
}

export function resolveOrchestrate(input: {
  org?: unknown;
  team?: unknown;
  repo?: unknown;
  policyModels?: string[];
  locked?: string[];
  teamName?: string;
}): ReturnType<typeof resolveOrchestrateInner> {
  return resolveOrchestrateInner({
    ...input,
    org: expandLevel(input.org),
    team: expandLevel(input.team),
    repo: expandLevel(input.repo),
  });
}

export function orchestrateOf(config: { orchestrate?: OrchestrateSpec }): Orchestrate {
  return resolveOrchestrate({ repo: config.orchestrate }).value;
}

export function orchestrateActive(
  state: { getToggle(key: string, fallback: boolean): boolean },
  config: { orchestrate?: OrchestrateSpec },
): boolean {
  return orchestrateOf(config).enabled && state.getToggle("orchestrate", true);
}
