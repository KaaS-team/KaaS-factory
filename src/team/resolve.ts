// Four rules decide a team's config. Preferences: the most local level wins. Policy: the strictest
// value wins, so no level loosens what the one above set. Roles, workflows and routes: replaced by
// name, except a name the org locked. The org can also lock workflow, autonomy, model and any policy
// rule (budget_usd_month, models, ...): a lower level cannot change a locked value the org set. Levels apply in the order builtin, org, team, repo.
import { type Level as AutonomyLevel, levelRank } from "./approval";
import { resolveCapabilities } from "./capabilities";
import { DENY_RULES, type DenyKind, type OrgFile, RISKS, type TeamFile } from "./schema";

export type Level = "builtin" | "org" | "team" | "repo";
type Obj = Record<string, unknown>;

export interface Resolved {
  values: Obj;
  origin: Record<string, string>;
  problems: string[];
  // The org's deny marks, and each soft-deny rule a named approver lifted for the team.
  denied: Record<string, DenyKind>;
  lifted: Record<string, string>;
}

interface Deny {
  marks: Record<string, DenyKind>;
  lifted: Record<string, string>;
}

interface Prefs {
  model?: string;
  workflow?: string;
  autonomy?: string;
  labels?: Record<string, string>;
  timeouts?: Record<string, number>;
}

export interface ResolveInput {
  builtin: Obj;
  org?: OrgFile & Prefs;
  team?: TeamFile & Prefs;
  repo?: Obj;
}

const PREFERENCES = ["model", "workflow", "autonomy", "labels", "timeouts"];
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

  // The org set this path and no lower level has replaced it yet.
  private orgHolds(path: string): boolean {
    return Object.keys(this.origin).some((k) => (k === path || k.startsWith(`${path}.`)) && this.origin[k] === "org");
  }

  preferences(from: Obj, level: Level, locked: readonly string[] = [], who = ""): void {
    for (const key of PREFERENCES) {
      const v = from[key];
      if (v !== undefined && level !== "org" && locked.includes(key) && this.orgHolds(key)) {
        if (JSON.stringify(v) !== JSON.stringify(this.get(key)))
          this.problems.push(`${who} tried to set ${key}, which the org locked; the org's value stays.`);
        continue;
      }
      if (isObj(v)) for (const [k, x] of Object.entries(v)) this.set(`${key}.${k}`, x, level);
      else if (v !== undefined) this.set(key, v, level);
    }
  }

  policy(from: unknown, level: Level, union: boolean, deny: Deny, who: string, locked: readonly string[] = []): void {
    if (!isObj(from)) return;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const pick = (path: string, v: unknown, wins: (cur: unknown, v: unknown) => unknown) => {
      if (v === undefined) return;
      const cur = this.get(path);
      const rule = path.slice("policy.".length);
      if (level !== "org" && locked.includes(rule) && this.orgHolds(path)) {
        if (!same(cur, v))
          this.problems.push(`${who} tried to set ${rule}, which the org locked; the org's value stays.`);
        return;
      }
      const kind = level === "org" ? undefined : deny.marks[rule];
      if (kind === "hard" && !(cur !== undefined && same(cur, v))) {
        this.problems.push(
          `${who} tried to set ${path}, which the org marked hard-deny; no approval, workflow or team override lifts it, so the org's value stays.`,
        );
        return;
      }
      let next = cur === undefined ? v : wins(cur, v);
      if (kind === "soft" && !same(next, v)) {
        if (deny.lifted[rule] !== undefined) next = v;
        else
          this.problems.push(
            `${who} asked for a looser ${path}, which the org marked soft-deny; it needs a named approver in preapprove, so the stricter value stays.`,
          );
      }
      if (!same(next, cur)) this.set(path, next, level);
    };
    const lowest = (cur: unknown, v: unknown) => ((v as number) < (cur as number) ? v : cur);
    const lowestRisk = (cur: unknown, v: unknown) => (rank(v) < rank(cur) ? v : cur);
    const am = isObj(from.auto_merge) ? from.auto_merge : {};
    const ap = isObj(from.approvals) ? from.approvals : {};
    const eg = isObj(from.egress) ? from.egress : {};
    pick("policy.risk_max", from.risk_max, lowestRisk);
    pick("policy.auto_merge.allowed", am.allowed, (cur, v) => stricter(cur as boolean, v as boolean));
    pick("policy.auto_merge.max_risk", am.max_risk, lowestRisk);
    pick("policy.approvals.requester_cannot_approve", ap.requester_cannot_approve, (cur, v) => !stricter(!cur, !v));
    pick("policy.budget_usd_month", from.budget_usd_month, lowest);
    const list = (cur: unknown, v: unknown) => (cur as string[]).filter((x) => (v as string[]).includes(x));
    pick("policy.models", from.models, list);
    pick("policy.egress.hosts", eg.hosts, list);
    const lowestLevel = (cur: unknown, v: unknown) =>
      levelRank(v as AutonomyLevel) < levelRank(cur as AutonomyLevel) ? v : cur;
    pick("policy.autonomy_level", from.autonomy_level, lowestLevel);
    pick("policy.approval_chains", from.approval_chains, (cur, v) => [
      ...(cur as unknown[]),
      ...(v as unknown[]).filter((c) => !(cur as unknown[]).some((x) => same(x, c))),
    ]);
    pick("policy.egress.secrets", eg.secrets, list);
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

// Reads the org's deny marks and checks the team's pre-approvals against them. Only a soft-deny rule
// named by an approver in the team's own approvers list is lifted; each refusal is one problem.
function denyOf(input: ResolveInput, problems: string[]): Deny {
  const marks: Record<string, DenyKind> = {};
  for (const [rule, kind] of Object.entries(input.org?.policy?.deny ?? {}))
    if (DENY_RULES.includes(rule) && (kind === "hard" || kind === "soft")) marks[rule] = kind;
  const lifted: Record<string, string> = {};
  const team = input.team;
  for (const [rule, approver] of Object.entries(team?.policy?.preapprove ?? {})) {
    const who = `team ${team?.name}`;
    if (marks[rule] === undefined)
      problems.push(`${who} pre-approved policy.${rule}, which the org did not mark soft-deny.`);
    else if (marks[rule] === "hard")
      problems.push(`${who} pre-approved policy.${rule}, which the org marked hard-deny; approval cannot lift it.`);
    else if (!(team?.approvers ?? []).includes(approver))
      problems.push(`${who} pre-approved policy.${rule} by ${approver}, who is not one of its approvers.`);
    else lifted[rule] = approver;
  }
  return { marks, lifted };
}

export function resolveTeam(input: ResolveInput): Resolved {
  const m = new Merge(input.builtin);
  const deny = denyOf(input, m.problems);
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
    m.preferences(from, level, locked, who);
    m.policy(from.policy, level, union, deny, who, locked);
  }
  const caps = resolveCapabilities({
    org: input.org as unknown as Obj | undefined,
    team: input.team as unknown as Obj | undefined,
    repo: input.repo,
    teamName: input.team?.name,
  });
  m.problems.push(...caps.problems);
  for (const [c, v] of Object.entries(caps.values)) {
    if (v.modeLevel !== "builtin") m.set(`capabilities.${c}.mode`, v.mode, v.modeLevel as Level);
    if (v.provider !== undefined) m.set(`capabilities.${c}.provider`, v.provider, v.providerLevel as Level);
    if (v.required) m.set(`capabilities.${c}.required`, true, v.requiredLevel as Level);
  }
  return { values: m.values, origin: m.origin, problems: m.problems, denied: deny.marks, lifted: deny.lifted };
}
