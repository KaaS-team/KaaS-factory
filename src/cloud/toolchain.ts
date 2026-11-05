// A cloud agent runs the target repo's own commands. Reading them from the repo's files keeps a brief from
// naming bun, make fast or tests/mutations in a repo that uses npm or cargo (#624).

export interface Toolchain {
  readonly install?: string;
  readonly gate?: string;
  readonly mutation?: string;
}

const LOCKFILES: readonly [file: string, install: string, run: string][] = [
  ["bun.lock", "bun install --frozen-lockfile", "bun run"],
  ["bun.lockb", "bun install --frozen-lockfile", "bun run"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm run"],
  ["yarn.lock", "yarn install --frozen-lockfile", "yarn run"],
  ["package-lock.json", "npm ci", "npm run"],
];

const hasTarget = (makefile: string | undefined, target: string): boolean =>
  makefile !== undefined && new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m").test(makefile);

function scripts(pkg: string | undefined): Record<string, string> {
  if (pkg === undefined) return {};
  try {
    const s = (JSON.parse(pkg) as { scripts?: unknown }).scripts;
    return s && typeof s === "object" ? (s as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function repoGate(json: string | undefined): string | undefined {
  if (json === undefined) return undefined;
  try {
    const g = (JSON.parse(json) as { gate?: unknown }).gate;
    return typeof g === "string" && g.trim() !== "" ? g : undefined;
  } catch {
    return undefined;
  }
}

// `read` returns a repo file's text, or undefined when it is absent.
export function toolchainOf(read: (path: string) => string | undefined): Toolchain {
  const makefile = read("Makefile");
  const pkg = scripts(read("package.json"));
  const lock = LOCKFILES.find(([f]) => read(f) !== undefined);
  const run = lock?.[2] ?? "npm run";
  const script = (names: readonly string[]) => names.find((n) => pkg[n] !== undefined);

  const gateScript = script(["check", "test"]);
  const gate =
    repoGate(read(".agents/repo.json")) ??
    (hasTarget(makefile, "check") ? "make check" : undefined) ??
    (hasTarget(makefile, "test") ? "make test" : undefined) ??
    (gateScript ? `${run} ${gateScript}` : undefined) ??
    (read("Cargo.lock") !== undefined ? "cargo test --locked" : undefined);

  const mutScript = script(["mutation", "mutants", "test:mutation"]);
  const mutation = hasTarget(makefile, "check-mutations")
    ? "make check-mutations"
    : mutScript
      ? `${run} ${mutScript}`
      : undefined;

  const install = lock?.[1] ?? (read("Cargo.lock") !== undefined ? "cargo fetch --locked" : undefined);
  return { install, gate, mutation };
}

export const NO_GATE_REASON =
  "this repo has no gate command (no .agents/repo.json gate, Makefile check or test target, or package.json check or test script), so the cloud build was not started";

export function toolchainLines(t: Toolchain): string[] {
  return [
    ...(t.install ? [`Install dependencies with \`${t.install}\`.`] : []),
    ...(t.gate ? [`Run \`${t.gate}\` before finishing; it is the repo's gate.`] : []),
    ...(t.mutation ? [`Run \`${t.mutation}\` for any check you add.`] : []),
  ];
}

// Why a cloud build must not start yet, or undefined when it may. `seed` is set when an earlier attempt pushed a branch.
export function launchRefusal(i: {
  toolchain: Toolchain;
  seed?: { branch: string; onRemote: boolean };
}): string | undefined {
  if (i.toolchain.gate === undefined) return NO_GATE_REASON;
  if (i.seed && !i.seed.onRemote)
    return `the seed branch ${i.seed.branch} is not on the remote, so the cloud build was not started`;
  return undefined;
}
