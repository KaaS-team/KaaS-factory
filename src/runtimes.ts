// Where a gate or a `check` step's command runs. "local" (this machine) and
// "lwpr" (the lwpr build box, as `lwpr` is configured here) always exist;
// FACTORY_HOME/machine.json `runtimes` names any others, because hosts and
// images belong to the machine, not the repo. The repo's `runtime.gates` and
// `runtime.check`, and a check step's own `runtime:`, pick one by name.
// A `pool` names `http` and `agent37` runtimes from the same file, in order, each with its
// free tier's monthly minutes (src/core/sandbox-pool.ts).

import { Agent37Execution, type Agent37Spec } from "./adapters/agent37/execution";
import { CodespacesExecution, type CodespacesSpec } from "./adapters/codespaces/execution";
import { DockerExecution, type DockerSpec } from "./adapters/docker/execution";
import { HttpSandboxExecution, type HttpSandboxSpec } from "./adapters/http-sandbox/execution";
import { LocalExecution } from "./adapters/local/execution";
import { LwprExecution, type LwprSpec } from "./adapters/lwpr/execution";
import { MicrosandboxExecution, type MicrosandboxSpec, SECRET } from "./adapters/microsandbox/execution";
import { PoolExecution, type PoolSpec, SqliteUsageStore } from "./adapters/pool/execution";
import { SshExecution, type SshSpec } from "./adapters/ssh/execution";
import { CMD, WrapExecution, type WrapSpec } from "./adapters/wrap/execution";
import { existsSync } from "node:fs";
import { factoryHome } from "./paths";
import type { ExecutionPort } from "./ports/execution";

export type RuntimeSpec =
  | { readonly kind: "local" }
  | DockerSpec
  | SshSpec
  | LwprSpec
  | WrapSpec
  | HttpSandboxSpec
  | Agent37Spec
  | MicrosandboxSpec
  | CodespacesSpec
  | PoolSpec;

export const BUILTIN_RUNTIMES: Readonly<Record<string, RuntimeSpec>> = {
  local: { kind: "local" },
  lwpr: { kind: "lwpr" },
};

// `default` is the one place the factory picks a sandbox for you: a microsandbox VM where `msb` and a
// hypervisor are present, otherwise this machine, which `factory doctor` warns about.
export const DEFAULT_RUNTIME = "default";
export const DEFAULT_VM: MicrosandboxSpec = { kind: "microsandbox", image: "node:22-slim", memory: "1G", cpus: 1 };

export interface HostProbe {
  readonly which: (bin: string) => boolean;
  readonly hypervisor: () => boolean;
}
export const hostProbe: HostProbe = {
  which: (bin) => Bun.which(bin) !== null,
  hypervisor: () =>
    process.platform === "darwin"
      ? Bun.spawnSync(["sysctl", "-n", "kern.hv_support"]).stdout.toString().trim() === "1"
      : existsSync("/dev/kvm"),
};

export function defaultRuntime(probe: HostProbe = hostProbe): { spec: RuntimeSpec; warning?: string } {
  const local = (why: string) => ({
    spec: { kind: "local" } as const,
    warning: `${why}, so \`default\` runs on this machine unsandboxed`,
  });
  if (!probe.which("msb")) return local("msb is not installed");
  if (!probe.hypervisor()) return local("no hypervisor (KVM or Hypervisor.framework)");
  return { spec: DEFAULT_VM };
}

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
  agent37: {
    required: ["instance", "tokenEnv"],
    fields: { instance: "string", tokenEnv: "string", url: "string", root: "string", exclude: "strings" },
  },
  microsandbox: {
    required: ["image"],
    fields: { image: "string", allow: "strings", secrets: "strings", memory: "string", cpus: "posInt" },
  },
  codespaces: {
    required: ["codespace"],
    fields: { codespace: "string", tokenEnv: "string", root: "string", exclude: "strings" },
  },
  pool: { required: ["members"], fields: { members: "members", reserveMin: "posInt", fallback: "string" } },
};

export const RUNTIME_KINDS = Object.keys(SHAPES) as RuntimeSpec["kind"][];

// Kinds a pool can cut off at the minutes it holds: one fetch each, aborted by its signal.
const POOLABLE = new Set<unknown>(["http", "agent37"]);

// What a field's shape cannot say. `all` is the whole runtimes object, for a pool's members.
function kindProblems(at: string, s: Record<string, unknown>, all: Record<string, unknown>): string[] {
  if (s.kind === "pool" && Array.isArray(s.members)) {
    const names = s.members.map((m: { runtime?: unknown }) => m.runtime);
    return [
      ...(s.members.length ? [] : [`${at}.members: at least one`]),
      ...names
        .filter((n) => !POOLABLE.has((all[n as string] as { kind?: unknown } | undefined)?.kind))
        .map(
          (n) =>
            `${at}.members: "${n}" is not an http or agent37 runtime in this file (only those stop at the allowance)`,
        ),
      ...names.filter((n, i) => names.indexOf(n) !== i).map((n) => `${at}.members: "${n}" twice`),
      ...fallbackProblems(at, s.fallback, all),
    ];
  }
  if (s.kind === "wrap" && Array.isArray(s.argv) && s.argv.filter((a) => a === CMD).length !== 1)
    return [`${at}.argv: needs "${CMD}" as exactly one element, where the bash command goes`];
  if (
    (s.kind === "http" || s.kind === "agent37") &&
    typeof s.url === "string" &&
    !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(s.url)
  )
    return [`${at}.url: https (plain http only to localhost), since the worktree is sent to it`];
  if (s.kind === "microsandbox" && Array.isArray(s.secrets)) return secretProblems(at, s.secrets, s.allow);
  return [];
}

// A secret's hosts must be reachable, or the key is injected nowhere and the run fails late.
function secretProblems(at: string, secrets: unknown[], allow: unknown): string[] {
  const reachable = new Set(Array.isArray(allow) ? allow : []);
  return secrets.flatMap((s) => {
    const m = SECRET.exec(String(s));
    if (!m) return [`${at}.secrets: "${s}" is not ENV@host[,host]`];
    return (m[2] ?? "")
      .split(",")
      .filter((h) => !reachable.has(h))
      .map((h) => `${at}.secrets: "${s}" sends to ${h}, which is not in allow`);
  });
}

// A pool's fallback is "none", a built-in, or a runtime in the same file that is not itself a pool.
function fallbackProblems(at: string, fallback: unknown, all: Record<string, unknown>): string[] {
  if (typeof fallback !== "string" || fallback === "none" || Object.hasOwn(BUILTIN_RUNTIMES, fallback)) return [];
  const kind = (all[fallback] as { kind?: unknown } | undefined)?.kind;
  if (kind === undefined) return [`${at}.fallback: no runtime "${fallback}" (or "none")`];
  return kind === "pool" ? [`${at}.fallback: "${fallback}" is a pool`] : [];
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
    if (Object.hasOwn(BUILTIN_RUNTIMES, name) || name === DEFAULT_RUNTIME)
      problems.push(`${at}: "${name}" is built in`);
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
    case "agent37":
      return new Agent37Execution(spec);
    case "microsandbox":
      return new MicrosandboxExecution(spec);
    case "codespaces":
      return new CodespacesExecution(spec);
  }
}

// Every runtime name and its spec: `default`, the built-ins, then the machine's own.
export function runtimeSpecs(
  machine: Readonly<Record<string, RuntimeSpec>> = {},
  probe: HostProbe = hostProbe,
): Readonly<Record<string, RuntimeSpec>> {
  return { [DEFAULT_RUNTIME]: defaultRuntime(probe).spec, ...BUILTIN_RUNTIMES, ...machine };
}

// One ExecutionPort per runtimeSpecs entry; a pool after the runtimes it names, falling back to local.
export function runtimesFrom(
  machine: Readonly<Record<string, RuntimeSpec>> = {},
  env: NodeJS.ProcessEnv = process.env,
  probe: HostProbe = hostProbe,
): Readonly<Record<string, ExecutionPort>> {
  const ports: Record<string, ExecutionPort> = {};
  const all = Object.entries(runtimeSpecs(machine, probe));
  for (const [name, spec] of all) if (spec.kind !== "pool") ports[name] = executionFor(spec);
  let store: SqliteUsageStore | undefined;
  for (const [name, spec] of all)
    if (spec.kind === "pool") {
      store ??= new SqliteUsageStore(poolDbPath(env));
      const fallback = spec.fallback === "none" ? undefined : ports[spec.fallback ?? "local"];
      ports[name] = new PoolExecution(spec, ports, fallback, store);
    }
  return ports;
}

// Pool usage shares machine.db with slot leases and spend.
export function poolDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${factoryHome(env)}/machine.db`;
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
