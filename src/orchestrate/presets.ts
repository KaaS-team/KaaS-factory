import type { OrchestrateSpec } from "./types";

export type OrchestratePreset = "split" | "all-claude" | "all-cursor";
export const PRESET_NAMES: readonly OrchestratePreset[] = ["split", "all-claude", "all-cursor"];

const offClaude = { "claude-cloud": { max: 0 } };

export const PRESETS: Record<OrchestratePreset, OrchestrateSpec> = {
  split: {
    providers: { ...offClaude },
    roles: { build: ["cursor-cloud", "local"] },
  },
  "all-claude": {
    providers: { "cursor-cloud": { max: 0 }, "claude-cloud": { max: 4 } },
    roles: { build: ["claude-cloud", "local"] },
  },
  "all-cursor": {
    providers: { ...offClaude },
    roles: { build: ["cursor-cloud", "local"], groom: "cursor-cloud" },
    groom: { model: "auto" },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mergeSpec(base: OrchestrateSpec, overlay: OrchestrateSpec): OrchestrateSpec {
  const out: OrchestrateSpec = structuredClone(base);
  for (const [k, v] of Object.entries(overlay) as [keyof OrchestrateSpec, unknown][]) {
    if (v === undefined) continue;
    if (k === "providers" && isObj(v)) {
      out.providers ??= {};
      for (const [name, ps] of Object.entries(v)) {
        if (!isObj(ps)) continue;
        out.providers[name] = { ...out.providers[name], ...ps };
      }
      continue;
    }
    if (k === "roles" && isObj(v)) {
      out.roles = { ...out.roles, ...(v as OrchestrateSpec["roles"]) };
      continue;
    }
    if (k === "groom" && isObj(v)) {
      out.groom = { ...out.groom, ...(v as OrchestrateSpec["groom"]) };
      continue;
    }
    if (k === "cost" && isObj(v)) {
      out.cost = { ...out.cost, ...(v as OrchestrateSpec["cost"]) };
      continue;
    }
    (out as Record<string, unknown>)[k as string] = v;
  }
  return out;
}

export function expandPreset(spec: OrchestrateSpec & { preset?: OrchestratePreset }): OrchestrateSpec {
  const { preset, ...rest } = spec;
  if (preset === undefined) return rest;
  return mergeSpec(PRESETS[preset], rest);
}
