// ExecutionPort in a microsandbox microVM (`msb`): the worktree is mounted at
// its own path, egress is denied except to the hosts in `allow`, and each
// secret stays on this machine. The VM sees a placeholder; msb swaps in the
// real value only on a request to that secret's own hosts, so a command that
// prints or posts the variable elsewhere leaks nothing.

import { realpathSync } from "node:fs";
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

// `host` is cwd with symlinks resolved, which msb requires of a mount source (macOS /var is one).
export function sandboxArgs(spec: MicrosandboxSpec, cmd: string, cwd: string, name: string, host = cwd): string[] {
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
    ...(spec.secrets ?? []).flatMap((s) => ["--secret", s]),
    "--secret-violation-action",
    "block-and-log",
    "-m",
    spec.memory ?? "4G",
    "-c",
    String(spec.cpus ?? 2),
    "-v",
    `${host}:${cwd}`,
    "-w",
    cwd,
    spec.image,
    "--",
    "bash",
    "-c",
    cmd,
  ];
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
    // Killing msb alone can leave the VM running; remove it by name.
    const stop = () => Bun.spawn(["msb", "rm", "-f", "-q", name], { stdout: "ignore", stderr: "ignore" });
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
