import { PRIORITY_RULES } from "./types";

const BUILTIN = ["cursor-cloud", "claude-cloud", "cursor-local"] as const;
const OK_PH = new Set(["{promptFile}", "{branch}", "{repo}", "{session}", "{issue}"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && (v as number) > 0;

function uk(raw: Record<string, unknown>, allow: readonly string[], where: string, out: string[]): void {
  for (const k of Object.keys(raw)) if (!allow.includes(k)) out.push(`${where}.${k}: unknown key`);
}
function cmds(path: string, v: unknown, out: string[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    return void out.push(`${path}: expected a list of strings`);
  for (const s of v) {
    if (s.includes("{prompt}")) {
      out.push(`${path}: must not contain {prompt}; use {promptFile}`);
      continue;
    }
    for (const m of s.match(/\{[^}]+\}/g) ?? []) if (!OK_PH.has(m)) out.push(`${path}: unknown placeholder ${m}`);
  }
}

export function orchestrateProblems(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return [`${where}: expected an object`];
  const out: string[] = [];
  uk(raw, ["enabled", "providers", "roles", "priority", "groom", "cost", "promptMaxBytes"], where, out);
  if (raw.promptMaxBytes !== undefined && !(Number.isInteger(raw.promptMaxBytes) && (raw.promptMaxBytes as number) > 0))
    out.push(`${where}.promptMaxBytes: expected a positive whole number`);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    out.push(`${where}.enabled: expected true or false`);
  if (Array.isArray(raw.priority))
    for (const [i, e] of raw.priority.entries())
      if (!(PRIORITY_RULES as readonly string[]).includes(String(e)))
        out.push(`${where}.priority[${i}]: expected one of ${PRIORITY_RULES.join(", ")}`);
      else if (raw.priority !== undefined) out.push(`${where}.priority: expected a list`);
  if (isObj(raw.providers))
    for (const [name, spec] of Object.entries(raw.providers)) {
      const p = `${where}.providers.${name}`;
      if (!isObj(spec)) {
        out.push(`${p}: expected an object`);
        continue;
      }
      uk(spec, ["max", "model", "timeoutMinutes", "keyEnv", "launch", "status", "cancel"], p, out);
      if (spec.max !== undefined && !whole(spec.max)) out.push(`${p}.max: expected a whole number, 0 or more`);
      if (spec.timeoutMinutes !== undefined && !pos(spec.timeoutMinutes))
        out.push(`${p}.timeoutMinutes: expected a positive number`);
      if (spec.keyEnv !== undefined && (typeof spec.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(spec.keyEnv)))
        out.push(`${p}.keyEnv: expected an env var name like MY_KEY`);
      if (name === "cursor-cloud" && typeof spec.model === "string" && spec.model.toLowerCase().includes("fast"))
        out.push(`${p}.model: cursor-cloud model must be a standard model, not a fast one`);
      cmds(`${p}.launch`, spec.launch, out);
      cmds(`${p}.status`, spec.status, out);
      cmds(`${p}.cancel`, spec.cancel, out);
    }
  else if (raw.providers !== undefined) out.push(`${where}.providers: expected an object`);
  if (isObj(raw.roles)) {
    uk(raw.roles, ["build", "groom"], `${where}.roles`, out);
    const ok = new Set([...BUILTIN, ...(isObj(raw.providers) ? Object.keys(raw.providers) : []), "local"]);
    if (raw.roles.build !== undefined) {
      if (!Array.isArray(raw.roles.build) || !raw.roles.build.every((x) => typeof x === "string"))
        out.push(`${where}.roles.build: expected a list of strings`);
      else
        for (const e of raw.roles.build)
          if (!ok.has(e)) out.push(`${where}.roles.build: ${JSON.stringify(e)} is not local or a provider name`);
    }
    if (raw.roles.groom !== undefined && typeof raw.roles.groom !== "string")
      out.push(`${where}.roles.groom: expected a string`);
  } else if (raw.roles !== undefined) out.push(`${where}.roles: expected an object`);
  if (isObj(raw.groom)) {
    uk(raw.groom, ["enabled", "target", "label", "perTick", "epicMinutes", "model"], `${where}.groom`, out);
    if (raw.groom.enabled !== undefined && typeof raw.groom.enabled !== "boolean")
      out.push(`${where}.groom.enabled: expected true or false`);
    for (const k of ["target", "perTick", "epicMinutes"] as const)
      if (raw.groom[k] !== undefined && !whole(raw.groom[k]))
        out.push(`${where}.groom.${k}: expected a whole number, 0 or more`);
  } else if (raw.groom !== undefined) out.push(`${where}.groom: expected an object`);
  if (isObj(raw.cost)) {
    uk(raw.cost, ["perRunUsd", "perDayUsd", "intakeStopUsd"], `${where}.cost`, out);
    for (const k of ["perRunUsd", "perDayUsd", "intakeStopUsd"] as const)
      if (raw.cost[k] !== undefined && !pos(raw.cost[k])) out.push(`${where}.cost.${k}: expected a positive number`);
    const d = raw.cost.perDayUsd;
    const s = raw.cost.intakeStopUsd;
    if (typeof d === "number" && typeof s === "number" && s > d)
      out.push(`${where}.cost.intakeStopUsd: must not exceed perDayUsd`);
  } else if (raw.cost !== undefined) out.push(`${where}.cost: expected an object`);
  return out;
}
