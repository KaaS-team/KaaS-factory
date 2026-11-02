export interface ProviderSpec {
  max?: number;
  model?: string;
  timeoutMinutes?: number;
  keyEnv?: string;
  launch?: string[];
  status?: string[];
  cancel?: string[];
}
export interface OrchestrateSpec {
  enabled?: boolean;
  providers?: Record<string, ProviderSpec>;
  roles?: { build?: string[]; groom?: string };
  priority?: PriorityRule[];
  groom?: {
    enabled?: boolean;
    target?: number;
    label?: string;
    perTick?: number;
    epicMinutes?: number;
    model?: string;
  };
  cost?: { perRunUsd?: number; perDayUsd?: number; intakeStopUsd?: number };
}
export interface Provider {
  max: number;
  model: string;
  timeoutMinutes: number;
  keyEnv: string;
  launch: string[];
  status: string[];
  cancel: string[];
}
export interface Orchestrate {
  enabled: boolean;
  providers: Record<string, Provider>;
  roles: { build: string[]; groom: string };
  priority: PriorityRule[];
  groom: { enabled: boolean; target: number; label: string; perTick: number; epicMinutes: number; model: string };
  cost: { perRunUsd: number; perDayUsd: number; intakeStopUsd: number };
}
export const PRIORITY_RULES = ["label", "rank", "risk", "size", "epic", "number"] as const;
export type PriorityRule = (typeof PRIORITY_RULES)[number];

const defCursor: Provider = {
  max: 4,
  model: "auto",
  timeoutMinutes: 90,
  keyEnv: "CURSOR_API_KEY",
  launch: [],
  status: [],
  cancel: [],
};
const defClaude: Provider = {
  max: 0,
  model: "opusplan",
  timeoutMinutes: 90,
  keyEnv: "",
  launch: [],
  status: [],
  cancel: [],
};

// model ids are not verified here; confirm with GET /v1/models (cursor) or the claude CLI model list; opusplan uses Opus only in plan mode, fall back to opus if a read-only stage rejects it
export const DEFAULT_ORCHESTRATE: Orchestrate = {
  enabled: false,
  providers: { "cursor-cloud": { ...defCursor }, "claude-cloud": { ...defClaude } },
  roles: { build: ["cursor-cloud", "local"], groom: "" },
  priority: [...PRIORITY_RULES],
  groom: { enabled: false, target: 4, label: "needs-plan", perTick: 1, epicMinutes: 120, model: "opusplan" },
  cost: { perRunUsd: 5, perDayUsd: 50, intakeStopUsd: 40 },
};

export function defaultProvider(name: string, cur?: Provider): Provider {
  if (cur) return structuredClone(cur);
  if (name === "cursor-cloud") return { ...defCursor };
  if (name === "claude-cloud") return { ...defClaude };
  return { max: 0, model: "auto", timeoutMinutes: 90, keyEnv: "", launch: [], status: [], cancel: [] };
}
