// Capabilities in team config: each has a mode (off, byo, ours), an optional provider and a required
// flag. Preferences: the most local level wins. Policy: allow and providers lists intersect across
// levels, and required holds when any level sets it. Violations come back as one sentence each.
import { CAPABILITIES, MODES } from "../settings/registry";

type Obj = Record<string, unknown>;
type Lv = "org" | "team" | "repo";

export interface CapabilityValue {
  mode: string;
  modeLevel: string;
  provider?: string;
  providerLevel?: string;
  required: boolean;
  requiredLevel?: string;
}

export interface CapabilityLevels {
  org?: Obj;
  team?: Obj;
  repo?: Obj;
  teamName?: string;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
const join = (l: string[]) => (l.length ? l.join(" or ") : "nothing");

export function resolveCapabilities(levels: CapabilityLevels): {
  values: Record<string, CapabilityValue>;
  problems: string[];
} {
  const name: Record<Lv, string> = { org: "the org", team: `team ${levels.teamName}`, repo: "the repo" };
  const problems: string[] = [];
  const prefs = (lv: Lv): Obj => {
    const c = levels[lv]?.capabilities;
    return isObj(c) ? c : {};
  };
  const pols = (lv: Lv): Obj => {
    const p = levels[lv]?.policy;
    return isObj(p) && isObj(p.capabilities) ? p.capabilities : {};
  };
  // Most local first.
  const order: Lv[] = ["repo", "team", "org"];
  const known = (CAPABILITIES as readonly string[]).slice();
  const seen = new Set<string>();
  for (const lv of order) {
    for (const [c] of [...Object.entries(prefs(lv)), ...Object.entries(pols(lv))]) {
      if (seen.has(`${lv}:${c}`)) continue;
      seen.add(`${lv}:${c}`);
      if (!known.includes(c))
        problems.push(`capabilities.${c} is set in ${name[lv]}, but ${c} is not a known capability.`);
    }
  }
  const values: Record<string, CapabilityValue> = {};
  for (const c of known) {
    const pref = (lv: Lv): Obj => (isObj(prefs(lv)[c]) ? (prefs(lv)[c] as Obj) : {});
    const pol = (lv: Lv): Obj => (isObj(pols(lv)[c]) ? (pols(lv)[c] as Obj) : {});
    const touched = order.some((lv) => Object.keys(pref(lv)).length || Object.keys(pol(lv)).length);
    if (!touched) continue;
    // Lists that limit: each level that holds one, org first.
    const limits = (field: "allow" | "providers"): { lv: Lv; list: string[] }[] =>
      (["org", "team"] as Lv[]).flatMap((lv) => {
        const list = asList(pol(lv)[field]);
        return list ? [{ lv, list }] : [];
      });
    const allow = limits("allow");
    const providers = limits("providers");
    const permits = (ls: { list: string[] }[], v: string) => ls.every((l) => l.list.includes(v));
    const forbidder = (ls: { lv: Lv; list: string[] }[], v: string) => ls.find((l) => !l.list.includes(v));
    const allowed = (MODES as readonly string[]).filter((m) => permits(allow, m));

    let mode = "ours";
    let modeLevel = "builtin";
    let chosen = false;
    for (const lv of order) {
      const v = pref(lv).mode;
      if (v === undefined) continue;
      const key = `capabilities.${c}.mode`;
      if (typeof v !== "string" || !(MODES as readonly string[]).includes(v)) {
        problems.push(`${key} is ${String(v)} in ${name[lv]}, but it must be one of ${join([...MODES])}.`);
        continue;
      }
      const bad = forbidder(allow, v);
      if (bad) {
        problems.push(`${key} is ${v} in ${name[lv]}, but ${name[bad.lv]} allows only ${join(bad.list)}.`);
        continue;
      }
      if (!chosen) {
        mode = v;
        modeLevel = lv;
        chosen = true;
      }
    }
    if (!chosen && !allowed.includes(mode) && allowed[0] !== undefined) {
      mode = allowed[0];
      modeLevel = allow[0] ? allow[0].lv : modeLevel;
    }

    let provider: string | undefined;
    let providerLevel: string | undefined;
    for (const lv of order) {
      const v = pref(lv).provider;
      if (v === undefined) continue;
      const key = `capabilities.${c}.provider`;
      if (typeof v !== "string") {
        problems.push(`${key} is not a string in ${name[lv]}.`);
        continue;
      }
      const bad = forbidder(providers, v);
      if (bad) {
        problems.push(`${key} is ${v} in ${name[lv]}, but ${name[bad.lv]} allows only ${join(bad.list)}.`);
        continue;
      }
      if (provider === undefined) {
        provider = v;
        providerLevel = lv;
      }
    }

    const levelsList = order.flatMap((lv) => [
      { lv, required: pref(lv).required },
      { lv, required: pol(lv).required },
    ]);
    const required = levelsList.some((l) => l.required === true);
    const requiredLevel = [...levelsList].reverse().find((l) => l.required === true)?.lv;
    if (required && mode === "off") {
      const off = order.find((lv) => pref(lv).mode === "off");
      problems.push(
        `capabilities.${c}.mode is off in ${off ? name[off] : name[requiredLevel as Lv]}, but ${name[requiredLevel as Lv]} requires ${c}.`,
      );
    }
    values[c] = { mode, modeLevel, required };
    if (provider !== undefined) Object.assign(values[c] as CapabilityValue, { provider, providerLevel });
    if (requiredLevel) (values[c] as CapabilityValue).requiredLevel = requiredLevel;
  }
  return { values, problems };
}
