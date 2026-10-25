// Where a gate or a `check` step's command runs. "local" (this machine) and
// "lwpr" (the lwpr build box, as `lwpr` is configured here) always exist;
// FACTORY_HOME/machine.json `runtimes` names any others, because hosts and
// images belong to the machine, not the repo. The repo's `runtime.gates` and
// `runtime.check`, and a check step's own `runtime:`, pick one by name.
// A `pool` names `http` runtimes from the same file, in order, each with its
// free tier's monthly minutes (src/core/sandbox-pool.ts).

import { DockerExecution, type DockerSpec } from "./adapters/docker/execution";
import { HttpSandboxExecution, type HttpSandboxSpec } from "./adapters/http-sandbox/execution";
import { LocalExecution } from "./adapters/local/execution";
import { LwprExecution, type LwprSpec } from "./adapters/lwpr/execution";
import { FileUsageStore, PoolExecution, type PoolSpec } from "./adapters/pool/execution";
import { SshExecution, type SshSpec } from "./adapters/ssh/execution";
import { CMD, WrapExecution, type WrapSpec } from "./adapters/wrap/execution";
import { factoryHome } from "./paths";
import type { ExecutionPort } from "./ports/execution";

export type RuntimeSpec =
  | { readonly kind: "local" }
  | DockerSpec
  | SshSpec
  | LwprSpec
  | WrapSpec
  | HttpSandboxSpec
  | PoolSpec;

export const BUILTIN_RUNTIMES: Readonly<Record<string, RuntimeSpec>> = {
  local: { kind: "local" },
  lwpr: { kind: "lwpr" },
};

const NAME = /^[\w-]{1,64}$/;
type Field = "string" | "posInt" | "boolean" | "strings" | "members";
const SHAPES: Readonly<
  Record<RuntimeSpec["kind"], { required: readonly string[]; fields: Readonly<Record<string, Field>> }>
> = {
  local: { required: [], fields: {} },
  docker: {
    required: ["image"],
    fields: { image: "string", network: "string", memory: "string", cpus: "posInt", pids: "posInt", runtime: "string" },
  },
  ssh: { required: ["host", "dir"], fields: { host: "string", dir: "string", exclude: "strings" } },
  lwpr: { required: [], fields: { app: "string", timeoutMin: "posInt", setup: "boolean" } },
  wrap: { required: ["argv"], fields: { argv: "strings" } },
  http: { required: ["url"], fields: { url: "string", tokenEnv: "string", exclude: "strings" } },
  pool: { required: ["members"], fields: { members: "members", reserveMin: "posInt" } },
};

// What a field's shape cannot say. `all` is the whole runtimes object, for a pool's members.
function kindProblems(at: string, s: Record<string, unknown>, all: Record<string, unknown>): string[] {
  if (s.kind === "pool" && Array.isArray(s.members)) {
    const names = s.members.map((m: { runtime?: unknown }) => m.runtime);
    return [
      ...(s.members.length ? [] : [`${at}.members: at least one`]),
      ...names
        .filter((n) => (all[n as string] as { kind?: unknown } | undefined)?.kind !== "http")
        .map((n) => `${at}.members: "${n}" is not an http runtime in this file (only those stop at the allowance)`),
      ...names.filter((n, i) => names.indexOf(n) !== i).map((n) => `${at}.members: "${n}" twice`),
    ];
  }
  if (s.kind === "wrap" && Array.isArray(s.argv) && s.argv.filter((a) => a === CMD).length !== 1)
    return [`${at}.argv: needs "${CMD}" as exactly one element, where the bash command goes`];
  if (
    s.kind === "http" &&
    typeof s.url === "string" &&
    !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(s.url)
  )
    return [`${at}.url: https (plain http only to localhost), since the worktree is sent to it`];
  return [];
}

function fieldOk(v: unknown, f: Field): boolean {
  if (f === "string") return typeof v === "string" && v.length > 0;
  if (f === "posInt") return Number.isInteger(v) && (v as number) >= 1;
  if (f === "boolean") return typeof v === "boolean";
  if (f === "members")
    return (
      Array.isArray(v) &&
      v.every(
        (m) =>
          typeof m?.runtime === "string" &&
          Number.isInteger(m.minutes) &&
          m.minutes >= 1 &&
          Object.keys(m).every((k) => k === "runtime" || k === "minutes"),
      )
    );
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Every problem in a machine.json `runtimes` object, each with its path.
export function runtimeProblems(raw: unknown, where = "runtimes"): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${where}: an object of named runtimes`];
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${where}.${name}`;
    if (!NAME.test(name)) problems.push(`${at}: a name is letters, digits, _ and -`);
    if (Object.hasOwn(BUILTIN_RUNTIMES, name)) problems.push(`${at}: "${name}" is built in`);
    const s = (spec ?? {}) as Record<string, unknown>;
    const shape = SHAPES[s.kind as RuntimeSpec["kind"]];
    if (!shape) {
      problems.push(`${at}.kind: one of ${Object.keys(SHAPES).join(", ")}`);
      continue;
    }
    for (const k of shape.required) if (s[k] === undefined) problems.push(`${at}.${k}: required for ${s.kind}`);
    for (const [k, v] of Object.entries(s)) {
      if (k === "kind" || k.startsWith("_")) continue;
      const f = shape.fields[k];
      if (!f)
        problems.push(`${at}.${k}: unknown key for ${s.kind} (allowed: kind, ${Object.keys(shape.fields).join(", ")})`);
      else if (!fieldOk(v, f)) problems.push(`${at}.${k}: expected ${f}, got ${JSON.stringify(v)}`);
    }
    problems.push(...kindProblems(at, s, raw as Record<string, unknown>));
  }
  return problems;
}

export function executionFor(spec: Exclude<RuntimeSpec, PoolSpec>): ExecutionPort {
  switch (spec.kind) {
    case "local":
      return new LocalExecution();
    case "docker":
      return new DockerExecution(spec);
    case "ssh":
      return new SshExecution(spec);
    case "lwpr":
      return new LwprExecution(spec);
    case "wrap":
      return new WrapExecution(spec);
    case "http":
      return new HttpSandboxExecution(spec);
  }
}

// Built-ins plus the machine's own, one ExecutionPort each; a pool after the
// runtimes it names, falling back to local.
export function runtimesFrom(
  machine: Readonly<Record<string, RuntimeSpec>> = {},
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, ExecutionPort>> {
  const ports: Record<string, ExecutionPort> = {};
  const all = Object.entries({ ...BUILTIN_RUNTIMES, ...machine });
  for (const [name, spec] of all) if (spec.kind !== "pool") ports[name] = executionFor(spec);
  const store = new FileUsageStore(poolUsagePath(env));
  for (const [name, spec] of all)
    if (spec.kind === "pool") ports[name] = new PoolExecution(spec, ports, ports.local!, store);
  return ports;
}

export function poolUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  return `${factoryHome(env)}/pool-usage.json`;
}

// The runtime names a repo's config and workflow ask for, each with where it was asked.
export function runtimeRefs(
  config: { readonly runtime?: { readonly gates?: string; readonly check?: string } },
  steps: Readonly<Record<string, { readonly runtime?: string }>>,
): Array<{ where: string; name: string }> {
  return [
    ...(config.runtime?.gates ? [{ where: "runtime.gates", name: config.runtime.gates }] : []),
    ...(config.runtime?.check ? [{ where: "runtime.check", name: config.runtime.check }] : []),
    ...Object.entries(steps).flatMap(([id, s]) =>
      s.runtime ? [{ where: `steps.${id}.runtime`, name: s.runtime }] : [],
    ),
  ];
}

export function unknownRuntimes(
  refs: ReadonlyArray<{ where: string; name: string }>,
  known: Readonly<Record<string, unknown>>,
): string[] {
  return refs
    .filter((r) => !Object.hasOwn(known, r.name))
    .map(
      (r) =>
        `${r.where}: no runtime "${r.name}" (have: ${Object.keys(known).join(", ")}; add it to FACTORY_HOME/machine.json runtimes)`,
    );
}
