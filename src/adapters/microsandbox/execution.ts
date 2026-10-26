// ExecutionPort in a microsandbox microVM (`msb`): the worktree is mounted at
// its own path, egress is denied except to the hosts in `allow`, and each
// secret stays on this machine. The VM sees a placeholder; msb swaps in the
// real value only on a request to that secret's own hosts, so a command that
// prints or posts the variable elsewhere leaks nothing.

import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sparseCheckoutPatterns } from "../../git";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface MicrosandboxSpec {
  readonly kind: "microsandbox";
  // An OCI image with bash, such as "node:22-slim".
  readonly image: string;
  // Hostnames the command may reach on 443. Empty or absent: no network at all.
  readonly allow?: readonly string[];
  // "ENV@host[,host]": the env var ENV of this process, sent only to those hosts.
  readonly secrets?: readonly string[];
  readonly memory?: string;
  readonly cpus?: number;
}

export const SECRET = /^([A-Za-z_]\w*)@([\w.-]+(?:,[\w.-]+)*)$/;

// The VM and its egress, before the mounts and the command.
function vmArgs(spec: MicrosandboxSpec, name: string, extraSecrets: readonly string[] = []): string[] {
  const allow = spec.allow ?? [];
  return [
    "msb",
    "run",
    "-q",
    "--no-tty",
    "--no-stdin",
    "--name",
    name,
    "--no-net",
    ...(allow.length ? ["--net-rule", "allow@dns"] : []),
    ...allow.flatMap((h) => ["--net-rule", `allow@${h}:tcp:443`]),
    ...[...(spec.secrets ?? []), ...extraSecrets].flatMap((s) => ["--secret", s]),
    "--secret-violation-action",
    "block-and-log",
    "-m",
    spec.memory ?? "4G",
    "-c",
    String(spec.cpus ?? 2),
  ];
}

// `host` is cwd with symlinks resolved, which msb requires of a mount source (macOS /var is one).
export function sandboxArgs(spec: MicrosandboxSpec, cmd: string, cwd: string, name: string, host = cwd): string[] {
  return [...vmArgs(spec, name), "-v", `${host}:${cwd}`, "-w", cwd, spec.image, "--", "bash", "-c", cmd];
}

export interface AgentInVm {
  readonly argv: readonly string[];
  readonly cwd: string;
  // Folders besides cwd the agent reads or writes, such as the stage's scratch dir.
  readonly mounts: readonly string[];
  // What the guest sees. Only plain values: anything secret goes in spec.secrets.
  readonly env: Readonly<Record<string, string>>;
  // msb 0.7 does not forward piped stdin, so the prompt is read from this file in the guest.
  readonly stdinFile?: string;
  readonly name: string;
  // Per-run keys in spec.secrets' form, such as a stage's gateway key.
  readonly secrets?: readonly string[];
  // The worktree mounted read-only: an agent that leaves its process group still cannot write.
  readonly readOnly?: boolean;
}

export function agentArgs(
  spec: MicrosandboxSpec,
  run: AgentInVm,
  real: (p: string) => string = realpathSync,
): string[] {
  const command = run.stdinFile ? ["bash", "-c", 'exec "$@" < "$0"', run.stdinFile, ...run.argv] : [...run.argv];
  return [
    ...vmArgs(spec, run.name, run.secrets),
    "-v",
    `${real(run.cwd)}:${run.cwd}${run.readOnly ? ":ro" : ""}`,
    ...run.mounts.flatMap((d) => ["-v", `${real(d)}:${d}`]),
    ...Object.entries(run.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-w",
    run.cwd,
    spec.image,
    "--",
    ...command,
  ];
}

function git(args: string[], cwd: string, stdin?: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// The worktree's .git points into the host clone, which the VM does not mount. Mounting it would
// hand any agent `git show origin/main:holdout/x`, so the guest gets its own mirror with the
// hidden paths' blobs repacked out and a remote that leads nowhere: no push, no lazy fetch.
export function guestGit(cwd: string, scratch: string, hidden: readonly string[]): Record<string, string> {
  if (!git(["rev-parse", "--is-inside-work-tree"], cwd).ok) return {};
  const must = (args: string[], dir: string, stdin?: string) => {
    const r = git(args, dir, stdin);
    if (!r.ok) throw new Error(`microsandbox: git ${args.slice(0, 2).join(" ")} failed for the guest repo: ${r.err}`);
    return r.out;
  };
  const common = must(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const own = must(["rev-parse", "--absolute-git-dir"], cwd);
  const dir = join(scratch, "git");
  must(["clone", "-q", "--mirror", "--no-local", common, dir], scratch);
  must(["config", "--unset", "remote.origin.mirror"], dir);
  must(["config", "remote.origin.url", "/factory/withheld"], dir);
  must(["config", "remote.origin.promisor", "true"], dir);
  if (hidden.length) {
    const spec = must(["hash-object", "-w", "--stdin"], dir, `${sparseCheckoutPatterns(hidden).join("\n")}\n`);
    const drop = join(scratch, "withheld");
    mkdirSync(drop);
    must(
      [
        "repack",
        "-a",
        "-d",
        "-q",
        "--no-write-bitmap-index",
        `--filter=sparse:oid=${spec}`,
        `--filter-to=${drop}/pack`,
      ],
      dir,
    );
    rmSync(drop, { recursive: true, force: true });
  }
  must(["config", "core.bare", "false"], dir);
  const branch = git(["symbolic-ref", "-q", "HEAD"], cwd);
  if (branch.ok) must(["symbolic-ref", "HEAD", branch.out], dir);
  else must(["update-ref", "--no-deref", "HEAD", must(["rev-parse", "HEAD"], cwd)], dir);
  if (existsSync(join(own, "index"))) copyFileSync(join(own, "index"), join(dir, "index"));
  return { GIT_DIR: dir, GIT_WORK_TREE: cwd };
}

// Killing the msb client can leave the VM running; remove it by name.
export function removeVm(name: string): void {
  Bun.spawn(["msb", "rm", "-f", "-q", name], { stdout: "ignore", stderr: "ignore" });
}

export class MicrosandboxExecution implements ExecutionPort {
  constructor(
    private readonly spec: MicrosandboxSpec,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}
  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const unset = (this.spec.secrets ?? []).map((s) => SECRET.exec(s)?.[1]).filter((e) => !e || !this.env[e]);
    if (unset.length)
      return { stdout: "", stderr: "", code: 1, runtimeFailed: `microsandbox: env var ${unset[0]} is not set` };
    const name = `factory-${crypto.randomUUID()}`;
    const proc = Bun.spawn(sandboxArgs(this.spec, cmd, cwd, name, realpathSync(cwd)), {
      cwd,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stop = () => removeVm(name);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }
}
