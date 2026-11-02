// Resolved orchestrate settings: cloud agent caps, grooming, priority and spend limits.
export type {
  Orchestrate,
  OrchestrateSpec,
  PriorityRule,
  Provider,
  ProviderSpec,
} from "./types";
export { DEFAULT_ORCHESTRATE, PRIORITY_RULES } from "./types";
export { orchestrateProblems } from "./problems";
export { resolveOrchestrate } from "./resolve";

import type { Orchestrate, OrchestrateSpec } from "./types";
import { resolveOrchestrate } from "./resolve";

export function orchestrateOf(config: { orchestrate?: OrchestrateSpec }): Orchestrate {
  return resolveOrchestrate({ repo: config.orchestrate }).value;
}

export function orchestrateActive(
  state: { getToggle(key: string, fallback: boolean): boolean },
  config: { orchestrate?: OrchestrateSpec },
): boolean {
  return orchestrateOf(config).enabled && state.getToggle("orchestrate", true);
}
