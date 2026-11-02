import { stricter } from "../team/resolve";
import { DEFAULT_ORCHESTRATE, defaultProvider, type Orchestrate, type OrchestrateSpec } from "./types";

type Slice = OrchestrateSpec | undefined;
type Lv = { tag: string; who: string; slice: Slice };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

function leaves(prefix: string, v: unknown, out: string[] = []): string[] {
  if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(`${prefix}.${k}`, x, out);
  else out.push(prefix);
  return out;
}
function stamp(origin: Record<string, string>, path: string, tag: string, sample: unknown): void {
  for (const k of Object.keys(origin)) if (k === path || k.startsWith(`${path}.`)) delete origin[k];
  for (const l of leaves(path, sample)) origin[l] = tag;
}
function setSpec(spec: OrchestrateSpec, path: string, value: unknown): void {
  const keys = path.split(".");
  let node: Record<string, unknown> = spec as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(node[k])) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] as string] = clone(value);
}

export function resolveOrchestrate(input: {
  org?: unknown;
  team?: unknown;
  repo?: unknown;
  policyModels?: string[];
  locked?: string[];
  teamName?: string;
}): { value: Orchestrate; spec: OrchestrateSpec; origin: Record<string, string>; problems: string[] } {
  const value = clone(DEFAULT_ORCHESTRATE);
  const spec: OrchestrateSpec = {};
  const origin: Record<string, string> = {};
  const problems: string[] = [];
  for (const l of leaves("enabled", value)) origin[l] = "builtin";
  for (const [n, p] of Object.entries(value.providers))
    for (const l of leaves(`providers.${n}`, p)) origin[l] = "builtin";
  for (const l of leaves("roles", value.roles)) origin[l] = "builtin";
  for (const l of leaves("priority", value.priority)) origin[l] = "builtin";
  for (const l of leaves("groom", value.groom)) origin[l] = "builtin";
  for (const l of leaves("cost", value.cost)) origin[l] = "builtin";

  const tname = input.teamName ?? "team";
  const levels: Lv[] = [
    { tag: "org", who: "the org", slice: input.org as Slice },
    { tag: `team:${tname}`, who: `team ${tname}`, slice: input.team as Slice },
    { tag: "repo", who: "the repo", slice: input.repo as Slice },
  ];
  const locked = input.locked ?? [];
  const models = input.policyModels ?? [];

  const pickModel = (path: string, next: string | undefined, lv: Lv, apply: (m: string) => void) => {
    if (next === undefined) return;
    if (models.length && !models.includes(next)) {
      problems.push(
        `${lv.who} set ${path} to ${JSON.stringify(next)}, which is not in the org model list; the higher level's model stays.`,
      );
      return;
    }
    apply(next);
    stamp(origin, path, lv.tag, next);
    setSpec(spec, path, next);
  };
  const pickLow = (path: string, cur: number, next: number | undefined, lv: Lv, apply: (n: number) => void) => {
    if (next === undefined) return;
    if (next > cur) {
      problems.push(
        `${lv.who} asked for ${path} ${next}, which is higher than the current ${cur}; the lower value stays.`,
      );
      return;
    }
    const win = Math.min(cur, next);
    apply(win);
    stamp(origin, path, lv.tag, win);
    setSpec(spec, path, win);
  };
  const pickStrict = (path: string, cur: boolean, next: boolean | undefined, lv: Lv, apply: (b: boolean) => void) => {
    if (next === undefined) return;
    const builtinOnly = origin[path] === "builtin";
    const win = builtinOnly ? next : stricter(cur, next);
    if (!builtinOnly && next === true && cur === false)
      problems.push(`${lv.who} tried to enable ${path} while a higher level set it false; the stricter value stays.`);
    apply(win);
    stamp(origin, path, lv.tag, win);
    setSpec(spec, path, win);
  };

  for (const lv of levels) {
    const o = lv.slice;
    if (!o) continue;
    pickStrict("enabled", value.enabled, o.enabled, lv, (v) => {
      value.enabled = v;
    });
    pickStrict("groom.enabled", value.groom.enabled, o.groom?.enabled, lv, (v) => {
      value.groom.enabled = v;
    });
    const names = new Set([...Object.keys(value.providers), ...Object.keys(o.providers ?? {})]);
    for (const name of names) {
      const ps = o.providers?.[name];
      const p = (value.providers[name] = defaultProvider(name, value.providers[name]));
      pickLow(`providers.${name}.max`, p.max, ps?.max, lv, (v) => {
        p.max = v;
      });
      pickLow(`providers.${name}.timeoutMinutes`, p.timeoutMinutes, ps?.timeoutMinutes, lv, (v) => {
        p.timeoutMinutes = v;
      });
      pickModel(`providers.${name}.model`, ps?.model, lv, (m) => {
        p.model = m;
      });
      if (ps?.keyEnv !== undefined) {
        p.keyEnv = ps.keyEnv;
        stamp(origin, `providers.${name}.keyEnv`, lv.tag, ps.keyEnv);
        setSpec(spec, `providers.${name}.keyEnv`, ps.keyEnv);
      }
      for (const cmd of ["launch", "status", "cancel"] as const) {
        if (ps?.[cmd] === undefined) continue;
        p[cmd] = [...ps[cmd]!];
        stamp(origin, `providers.${name}.${cmd}`, lv.tag, p[cmd]);
        setSpec(spec, `providers.${name}.${cmd}`, p[cmd]);
      }
    }
    if (o.priority !== undefined) {
      value.priority = [...o.priority];
      stamp(origin, "priority", lv.tag, value.priority);
      spec.priority = [...o.priority];
    }
    if (o.groom?.label !== undefined) {
      value.groom.label = o.groom.label;
      stamp(origin, "groom.label", lv.tag, o.groom.label);
      setSpec(spec, "groom.label", o.groom.label);
    }
    pickModel("groom.model", o.groom?.model, lv, (m) => {
      value.groom.model = m;
    });
    pickLow("groom.target", value.groom.target, o.groom?.target, lv, (v) => {
      value.groom.target = v;
    });
    pickLow("groom.perTick", value.groom.perTick, o.groom?.perTick, lv, (v) => {
      value.groom.perTick = v;
    });
    pickLow("groom.epicMinutes", value.groom.epicMinutes, o.groom?.epicMinutes, lv, (v) => {
      value.groom.epicMinutes = v;
    });
    pickLow("cost.perRunUsd", value.cost.perRunUsd, o.cost?.perRunUsd, lv, (v) => {
      value.cost.perRunUsd = v;
    });
    pickLow("cost.perDayUsd", value.cost.perDayUsd, o.cost?.perDayUsd, lv, (v) => {
      value.cost.perDayUsd = v;
    });
    pickLow("cost.intakeStopUsd", value.cost.intakeStopUsd, o.cost?.intakeStopUsd, lv, (v) => {
      value.cost.intakeStopUsd = v;
    });
    const block = lv.tag !== "org" && locked.includes("orchestrate.roles");
    if (o.roles?.build !== undefined) {
      if (block)
        problems.push(`${lv.who} tried to replace orchestrate.roles, which the org locked; the org's version stays.`);
      else {
        value.roles.build = [...o.roles.build];
        stamp(origin, "roles.build", lv.tag, value.roles.build);
        setSpec(spec, "roles.build", value.roles.build);
      }
    }
    if (o.roles?.groom !== undefined) {
      if (block)
        problems.push(`${lv.who} tried to replace orchestrate.roles, which the org locked; the org's version stays.`);
      else {
        value.roles.groom = o.roles.groom;
        stamp(origin, "roles.groom", lv.tag, o.roles.groom);
        setSpec(spec, "roles.groom", o.roles.groom);
      }
    }
  }
  return { value, spec, origin, problems };
}
