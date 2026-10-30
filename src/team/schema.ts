// The shapes of an org file and a team file, and the plain-sentence checks that a loaded file has them.

export type Risk = "low" | "medium" | "high";

export interface RoleSpec {
  harness?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  runtime?: string;
  locked?: boolean;
}

export interface SourceSpec {
  kind: string;
  project?: string;
  ready?: string;
  statuses?: Record<string, string>;
  types?: Record<string, string>;
}

export interface PolicySpec {
  risk_max?: Risk;
  auto_merge?: { allowed?: boolean; max_risk?: string };
  models?: string[];
  protected_paths?: string[];
  approvals?: { requester_cannot_approve?: boolean };
  budget_usd_month?: number;
  extend?: boolean;
}

export interface TeamFile {
  name: string;
  mission?: string;
  members?: string[];
  approvers?: string[];
  repos?: string[];
  source?: SourceSpec;
  roles?: Record<string, RoleSpec>;
  routes?: Record<string, unknown>;
  workflows?: Record<string, unknown>;
  policy?: PolicySpec;
  budget_usd_month?: number;
  concurrency?: number;
}

export interface OrgFile {
  name: string;
  roles?: Record<string, RoleSpec>;
  workflows?: Record<string, unknown>;
  policy?: PolicySpec;
  locked?: string[];
}

export const RISKS: readonly Risk[] = ["low", "medium", "high"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

type Check = (path: string, v: unknown) => string | undefined;
const typed =
  (what: string, ok: (v: unknown) => boolean): Check =>
  (path, v) =>
    ok(v) ? undefined : `${path} must be ${what}.`;
const str = typed("a string", (v) => typeof v === "string");
const bool = typed("true or false", (v) => typeof v === "boolean");
const num = typed("a number", (v) => typeof v === "number" && Number.isFinite(v));
const strs = typed("a list of strings", isStrings);
const map = typed("a mapping", isObject);
const risk: Check = (path, v) =>
  RISKS.includes(v as Risk) ? undefined : `${path} must be low, medium or high, got ${JSON.stringify(v)}.`;

function fields(path: string, raw: unknown, shape: Record<string, Check>, out: string[]): void {
  if (!isObject(raw)) {
    out.push(`${path} must be a mapping.`);
    return;
  }
  for (const [key, check] of Object.entries(shape)) {
    if (raw[key] === undefined) continue;
    const problem = check(`${path}.${key}`, raw[key]);
    if (problem) out.push(problem);
  }
}

const dict =
  (each: (path: string, v: unknown, out: string[]) => void) => (path: string, raw: unknown, out: string[]) => {
    if (!isObject(raw)) return void out.push(`${path} must be a mapping.`);
    for (const [name, v] of Object.entries(raw)) each(`${path}.${name}`, v, out);
  };

const role = (path: string, v: unknown, out: string[]) =>
  fields(path, v, { harness: str, model: str, skills: strs, tools: strs, runtime: str, locked: bool }, out);
const roles = dict(role);

function policy(path: string, v: unknown, out: string[]): void {
  fields(
    path,
    v,
    {
      risk_max: risk,
      models: strs,
      protected_paths: strs,
      budget_usd_month: num,
      extend: bool,
      auto_merge: map,
      approvals: map,
    },
    out,
  );
  if (!isObject(v)) return;
  if (isObject(v.auto_merge)) fields(`${path}.auto_merge`, v.auto_merge, { allowed: bool, max_risk: risk }, out);
  if (isObject(v.approvals)) fields(`${path}.approvals`, v.approvals, { requester_cannot_approve: bool }, out);
}

function source(path: string, v: unknown, out: string[]): void {
  fields(path, v, { kind: str, project: str, ready: str, statuses: map, types: map }, out);
  if (isObject(v) && v.kind === undefined) out.push(`${path}.kind is required.`);
}

// Never throws: a file that is not even a mapping comes back as one sentence.
export function teamProblems(raw: unknown, kind: "org" | "team"): string[] {
  const out: string[] = [];
  if (!isObject(raw)) return [`The ${kind} file must be a mapping with a name.`];
  if (typeof raw.name !== "string" || raw.name === "") out.push("name is required and must be a non-empty string.");
  if (raw.roles !== undefined) roles("roles", raw.roles, out);
  if (raw.workflows !== undefined && !isObject(raw.workflows)) out.push("workflows must be a mapping.");
  if (raw.policy !== undefined) policy("policy", raw.policy, out);
  if (kind === "org") {
    if (raw.locked !== undefined) {
      const problem = strs("locked", raw.locked);
      if (problem) out.push(problem);
    }
    return out;
  }
  fields(
    "team",
    raw,
    {
      mission: str,
      members: strs,
      approvers: strs,
      repos: strs,
      budget_usd_month: num,
      concurrency: num,
      routes: map,
    },
    out,
  );
  if (raw.source !== undefined) source("source", raw.source, out);
  return out.map((p) => p.replace(/^team\./, ""));
}
