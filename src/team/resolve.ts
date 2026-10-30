// Four rules decide a team's config. Preferences: the most local level wins. Policy: the strictest
// value wins, so no level loosens what the one above set. Roles, workflows and routes: replaced by
// name, except a name the org locked. Levels apply in the order builtin, org, team, repo.
import { type OrgFile, RISKS, type TeamFile } from "./schema";

export type Level = "builtin" | "org" | "team" | "repo";
type Obj = Record<string, unknown>;

export interface Resolved {
  values: Obj;
  origin: Record<string, string>;
  problems: string[];
}

interface Prefs {
  model?: string;
  workflow?: string;
  labels?: Record<string, string>;
  timeouts?: Record<string, number>;
}

export interface ResolveInput {
  builtin: Obj;
  org?: OrgFile & Prefs;
  team?: TeamFile & Prefs;
  repo?: Obj;
}

const PREFERENCES = ["model", "workflow", "labels", "timeouts"];
const NAMED = ["roles", "workflows", "routes"];

// The caller passes the org value as a, the ceiling. The line stays as written: tests/mutations.json matches it.
// biome-ignore format: the mutation entry finds this exact text
export const stricter = (a: boolean, b: boolean): boolean => a === false || b === false ? false : a;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const rank = (r: unknown): number => RISKS.indexOf(r as (typeof RISKS)[number]);

function leaves(prefix: string, v: unknown, out: string[] = []): string[] {
  if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(`${prefix}.${k}`, x, out);
  else out.push(prefix);
  return out;
}

class Merge {
  readonly values: Obj;
  readonly origin: Record<string, string> = {};
  readonly problems: string[] = [];

  constructor(builtin: Obj) {
    this.values = clone(builtin);
    for (const [k, v] of Object.entries(this.values)) for (const l of leaves(k, v)) this.origin[l] = "builtin";
  }

  // Writes value at a dotted path and names level as the setter of every leaf below it.
  set(path: string, value: unknown, level: Level): void {
    const keys = path.split(".");
    let node = this.values;
    for (const k of keys.slice(0, -1)) {
      if (!isObj(node[k])) node[k] = {};
      node = node[k] as Obj;
    }
    node[keys[keys.length - 1] as string] = clone(value);
    for (const k of Object.keys(this.origin)) if (k === path || k.startsWith(`${path}.`)) delete this.origin[k];
    for (const l of leaves(path, value)) this.origin[l] = level;
  }

  get(path: string): unknown {
    let node: unknown = this.values;
    for (const k of path.split(".")) node = isObj(node) ? node[k] : undefined;
    return node;
  }

  preferences(from: Obj, level: Level): void {
    for (const key of PREFERENCES) {
      const v = from[key];
      if (isObj(v)) for (const [k, x] of Object.entries(v)) this.set(`${key}.${k}`, x, level);
      else if (v !== undefined) this.set(key, v, level);
    }
  }

  policy(from: unknown, level: Level, union: boolean): void {
    if (!isObj(from)) return;
    const pick = (path: string, v: unknown, wins: (cur: unknown, v: unknown) => unknown) => {
      if (v === undefined) return;
      const cur = this.get(path);
      const next = cur === undefined ? v : wins(cur, v);
      if (JSON.stringify(next) !== JSON.stringify(cur)) this.set(path, next, level);
    };
    const lowest = (cur: unknown, v: unknown) => ((v as number) < (cur as number) ? v : cur);
    const lowestRisk = (cur: unknown, v: unknown) => (rank(v) < rank(cur) ? v : cur);
    const am = isObj(from.auto_merge) ? from.auto_merge : {};
    const ap = isObj(from.approvals) ? from.approvals : {};
    pick("policy.risk_max", from.risk_max, lowestRisk);
    pick("policy.auto_merge.allowed", am.allowed, (cur, v) => stricter(cur as boolean, v as boolean));
    pick("policy.auto_merge.max_risk", am.max_risk, lowestRisk);
    pick("policy.approvals.requester_cannot_approve", ap.requester_cannot_approve, (cur, v) => !stricter(!cur, !v));
    pick("policy.budget_usd_month", from.budget_usd_month, lowest);
    const list = (cur: unknown, v: unknown) => (cur as string[]).filter((x) => (v as string[]).includes(x));
    pick("policy.models", from.models, list);
    pick("policy.protected_paths", from.protected_paths, (cur, v) =>
      union ? [...new Set([...(cur as string[]), ...(v as string[])])] : list(cur, v),
    );
  }

  named(from: Obj, level: Level, locked: readonly string[], who: string): void {
    for (const kind of NAMED) {
      const set = from[kind];
      if (!isObj(set)) continue;
      for (const [name, spec] of Object.entries(set)) {
        if (level !== "org" && locked.includes(name))
          this.problems.push(`${who} tried to replace ${kind}.${name}, which the org locked; the org's version stays.`);
        else this.set(`${kind}.${name}`, spec, level);
      }
    }
  }
}

export function resolveTeam(input: ResolveInput): Resolved {
  const m = new Merge(input.builtin);
  const levels: [Level, Obj | undefined, string][] = [
    ["org", input.org as unknown as Obj | undefined, "the org"],
    ["team", input.team as unknown as Obj | undefined, `team ${input.team?.name}`],
    ["repo", input.repo, "the repo"],
  ];
  const locked = input.org?.locked ?? [];
  const union = input.org?.policy?.extend === true;
  for (const [level, from, who] of levels) {
    if (!from) continue;
    m.named(from, level, locked, who);
    m.preferences(from, level);
    m.policy(from.policy, level, union);
  }
  return { values: m.values, origin: m.origin, problems: m.problems };
}
