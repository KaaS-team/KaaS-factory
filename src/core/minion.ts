// A minion: one agent run with no issue and no PR, started by an event or a
// schedule, whose JSON answer can go back out as an event. This file only
// parses one `.factory/minions/<name>.yml` and checks what needs no I/O; the
// engine (src/engine/minion.ts) checks agents, skills and MCP servers against
// the repo and runs it. Pure: no I/O, no adapter.

import { parseCron, wallClock, CronError, type Cron } from "./cron";
import { isEventType, isExternalEventType } from "./event";

export interface Minion {
  readonly name: string;
  readonly description: string;
  readonly on: { readonly event: string } | { readonly cron: Cron; readonly tz: string };
  readonly agent?: string;
  readonly skill?: string;
  readonly prompt: string;
  readonly mcp: readonly string[];
  // Emitted with the agent's JSON answer as its data.
  readonly emit?: string;
  readonly budgetUsd?: number;
  // Only "local" today: the run happens on this machine, in workspacesDir.
  readonly runtime: "local";
}

const KEYS = new Set(["name", "description", "on", "agent", "skill", "prompt", "mcp", "emit", "budgetUsd", "runtime"]);
const ON_KEYS = new Set(["event", "cron", "tz"]);
export const MINION_NAME = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseMinion(raw: unknown): { ok: true; minion: Minion } | { ok: false; problems: string[] } {
  if (!isObj(raw)) return { ok: false, problems: ["a minion must be a mapping"] };
  const problems: string[] = [];
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) problems.push(`${k}: unknown key (allowed: ${[...KEYS].join(", ")})`);
  const str = (k: string, required: boolean): string | undefined => {
    const v = raw[k];
    if (v === undefined) {
      if (required) problems.push(`${k}: required`);
      return undefined;
    }
    if (typeof v !== "string" || !v.trim()) problems.push(`${k}: must be a non-empty string`);
    return typeof v === "string" ? v : undefined;
  };
  const name = str("name", true) ?? "";
  if (name && !MINION_NAME.test(name)) problems.push(`name: "${name}" must be lowercase letters, digits and dashes`);
  const description = str("description", true) ?? "";
  const prompt = str("prompt", true) ?? "";
  const agent = str("agent", false);
  const skill = str("skill", false);
  if (skill !== undefined && !MINION_NAME.test(skill)) problems.push(`skill: "${skill}" must be a skill directory name under .claude/skills`);
  const emit = str("emit", false);
  // A minion speaks for another app (wiki, decisions, ...), never for the factory itself.
  if (emit !== undefined && !isExternalEventType(emit)) {
    problems.push(isEventType(emit) ? `emit: "${emit}" is a factory event; a minion may emit only another app's type` : `emit: "${emit}" is not an event type (see docs/events.md)`);
  }
  let mcp: string[] = [];
  if (raw.mcp !== undefined) {
    if (!Array.isArray(raw.mcp) || !raw.mcp.every((m) => typeof m === "string" && m)) problems.push("mcp: a list of server names in .factory/mcp.json");
    else mcp = raw.mcp as string[];
  }
  let budgetUsd: number | undefined;
  if (raw.budgetUsd !== undefined) {
    if (typeof raw.budgetUsd !== "number" || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd <= 0) problems.push("budgetUsd: must be a positive number");
    else budgetUsd = raw.budgetUsd;
  }
  if (raw.runtime !== undefined && raw.runtime !== "local") problems.push(`runtime: only "local" is supported, got ${JSON.stringify(raw.runtime)}`);

  let on: Minion["on"] | undefined;
  if (!isObj(raw.on)) problems.push("on: required, a mapping with event or cron");
  else {
    for (const k of Object.keys(raw.on)) if (!ON_KEYS.has(k)) problems.push(`on.${k}: unknown key (allowed: ${[...ON_KEYS].join(", ")})`);
    const { event, cron, tz } = raw.on;
    if ((event === undefined) === (cron === undefined)) problems.push("on: exactly one of event or cron");
    else if (event !== undefined) {
      if (typeof event !== "string" || !isEventType(event)) problems.push(`on.event: "${String(event)}" is not an event type (see docs/events.md)`);
      else if (event === emit) problems.push(`on.event: "${event}" is also what it emits, so it would wake itself`);
      else on = { event };
      if (tz !== undefined) problems.push("on.tz: only with cron");
    } else {
      const zone = tz === undefined ? "UTC" : tz;
      try {
        if (typeof zone !== "string") throw new CronError("tz must be a string");
        wallClock(new Date(0), zone);
        if (typeof cron !== "string") throw new CronError("five cron fields, as a string");
        on = { cron: parseCron(cron), tz: zone };
      } catch (e) {
        problems.push(`on.${e instanceof CronError && /zone|tz/.test(e.message) ? "tz" : "cron"}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (problems.length > 0 || !on) return { ok: false, problems };
  return {
    ok: true,
    minion: {
      name,
      description,
      on,
      prompt,
      mcp,
      runtime: "local",
      ...(agent !== undefined ? { agent } : {}),
      ...(skill !== undefined ? { skill } : {}),
      ...(emit !== undefined ? { emit } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    },
  };
}
