// The mapping file behind the generic tracker: which tool answers list, read and update, and where
// in its JSON answer an issue's fields sit. One file per tracker, no code. Shipped examples:
// docs/tracker-mappings/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAPPING_DIR = ".factory/trackers";
// list, read and update are the three the loop cannot run without; the others are optional.
export const REQUIRED_CALLS = ["list", "read", "update"] as const;
export const OPTIONAL_CALLS = ["comment", "create"] as const;
export type CallName = (typeof REQUIRED_CALLS)[number] | (typeof OPTIONAL_CALLS)[number];
const CALL_NAMES: readonly string[] = [...REQUIRED_CALLS, ...OPTIONAL_CALLS];
const FIELD_KEYS = ["number", "title", "body", "labels", "state"] as const;
const TOP_KEYS = ["server", "cli", "env", "calls", "fields", "states", "login"];
const CALL_KEYS = ["tool", "args", "argv", "items"];

export interface MappedCall {
  // MCP: the server's tool name and an argument template.
  readonly tool?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  // CLI: one argv entry per element, templates allowed in each.
  readonly argv?: readonly string[];
  // Dot path to the array (list) or object (read) inside the tool's JSON answer; unset is the whole answer.
  readonly items?: string;
}

export interface TrackerMapping {
  readonly server?: string;
  readonly cli?: string;
  // Env var names the server's mcp.json may expand as ${NAME}, after the runner-secret filter.
  readonly env: readonly string[];
  readonly calls: Readonly<Partial<Record<CallName, MappedCall>>>;
  readonly fields: Readonly<Record<(typeof FIELD_KEYS)[number], string>>;
  readonly states: { readonly open: string; readonly closed: string };
  readonly login: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function mappingProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ["a mapping is a JSON object"];
  const p: string[] = [];
  for (const k of Object.keys(raw))
    if (!TOP_KEYS.includes(k)) p.push(`${k}: unknown key (allowed: ${TOP_KEYS.join(", ")})`);
  if ((raw.server === undefined) === (raw.cli === undefined))
    p.push('name exactly one of "server" (an MCP server) or "cli" (a declared CLI tool)');
  for (const k of ["server", "cli", "login"] as const)
    if (raw[k] !== undefined && (typeof raw[k] !== "string" || !raw[k])) p.push(`${k}: must be a non-empty string`);
  if (
    raw.env !== undefined &&
    !(Array.isArray(raw.env) && raw.env.every((e) => typeof e === "string" && /^[A-Za-z_]\w*$/.test(e)))
  )
    p.push("env: must be a list of env var names");
  if (!isObj(raw.calls)) p.push('calls: needs an object with "list", "read" and "update"');
  else {
    for (const name of REQUIRED_CALLS) if (raw.calls[name] === undefined) p.push(`calls.${name}: required`);
    for (const [name, c] of Object.entries(raw.calls)) {
      const w = `calls.${name}`;
      if (!CALL_NAMES.includes(name)) p.push(`${w}: unknown call (allowed: ${CALL_NAMES.join(", ")})`);
      else if (!isObj(c)) p.push(`${w}: must be an object`);
      else {
        for (const k of Object.keys(c))
          if (!CALL_KEYS.includes(k)) p.push(`${w}.${k}: unknown key (allowed: ${CALL_KEYS.join(", ")})`);
        if (raw.server !== undefined && (typeof c.tool !== "string" || c.argv !== undefined))
          p.push(`${w}: a "server" mapping names a "tool" and "args", not "argv"`);
        if (
          raw.cli !== undefined &&
          (!Array.isArray(c.argv) ||
            c.argv.some((a) => typeof a !== "string") ||
            c.tool !== undefined ||
            c.args !== undefined)
        )
          p.push(`${w}: a "cli" mapping names "argv", a list of strings, not "tool" or "args"`);
        if (c.args !== undefined && !isObj(c.args)) p.push(`${w}.args: must be an object`);
        if (c.items !== undefined && typeof c.items !== "string") p.push(`${w}.items: must be a dot path string`);
      }
    }
  }
  const f = raw.fields;
  if (!isObj(f)) p.push("fields: needs an object");
  else
    for (const k of FIELD_KEYS)
      if (typeof f[k] !== "string") p.push(`fields.${k}: required, the dot path of the issue's ${k} in the answer`);
  if (
    raw.states !== undefined &&
    !(isObj(raw.states) && typeof raw.states.open === "string" && typeof raw.states.closed === "string")
  )
    p.push('states: needs "open" and "closed" strings');
  return p;
}

export function parseMapping(raw: unknown, source = "mapping"): TrackerMapping {
  const problems = mappingProblems(raw);
  if (problems.length > 0) throw new Error(`${source}: ${problems.join("; ")}`);
  const m = raw as Record<string, unknown>;
  return {
    ...(m.server === undefined ? {} : { server: m.server as string }),
    ...(m.cli === undefined ? {} : { cli: m.cli as string }),
    env: (m.env as string[] | undefined) ?? [],
    calls: m.calls as TrackerMapping["calls"],
    fields: m.fields as TrackerMapping["fields"],
    states: (m.states as TrackerMapping["states"] | undefined) ?? { open: "open", closed: "closed" },
    login: (m.login as string | undefined) ?? "mapped-tracker",
  };
}

// The mapping a tracker config names, read from the repo checkout.
export function readMapping(dir: string, name: string): TrackerMapping {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error(`tracker.mapping: "${name}" is not a mapping name`);
  const file = join(dir, MAPPING_DIR, `${name}.json`);
  if (!existsSync(file)) throw new Error(`tracker mapping "${name}" not found at ${MAPPING_DIR}/${name}.json`);
  try {
    return parseMapping(JSON.parse(readFileSync(file, "utf8")), `${MAPPING_DIR}/${name}.json`);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${MAPPING_DIR}/${name}.json is not JSON: ${e.message}`);
    throw e;
  }
}

export type Vars = Readonly<Record<string, unknown>>;

// `{{name}}` inside a string is replaced by its text. A string that is exactly `{{name}}` becomes the
// value itself, so a label list stays a list and a number stays a number.
export function fillTemplate(t: unknown, vars: Vars): unknown {
  if (typeof t === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(t);
    if (whole) return vars[whole[1]!] ?? "";
    return t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));
  }
  if (Array.isArray(t)) return t.map((x) => fillTemplate(x, vars));
  if (isObj(t)) return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return t;
}

export function atPath(v: unknown, path: string | undefined): unknown {
  if (!path) return v;
  let cur = v;
  for (const key of path.split(".")) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
