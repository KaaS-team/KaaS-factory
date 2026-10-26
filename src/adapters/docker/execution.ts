// ExecutionPort in a throwaway container: the worktree is bind-mounted at its
// own path, everything else is read-only, no capabilities, no privilege
// escalation, capped memory, CPU and processes, and no network unless the
// spec asks for it. The command runs as this user, so files it writes in the
// worktree are not root's.

import { resolveImage } from "../../images";
import type { AgentInVm, ExecResult, ExecutionPort } from "../../ports/execution";

export interface DockerSpec {
  readonly kind: "docker";
  // "auto" picks the repo's language image per run (src/images.ts).
  readonly image: string;
  // "none" (default) or a docker network name such as "bridge".
  readonly network?: string;
  readonly memory?: string;
  readonly cpus?: number;
  readonly pids?: number;
  // `--runtime`, for example "runsc" for gVisor.
  readonly runtime?: string;
}

export function containerArgs(
  spec: DockerSpec,
  cmd: string,
  cwd: string,
  user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=1g",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    spec.network ?? "none",
    "--memory",
    spec.memory ?? "4g",
    "--cpus",
    String(spec.cpus ?? 2),
    "--pids-limit",
    String(spec.pids ?? 512),
    ...(spec.runtime ? ["--runtime", spec.runtime] : []),
    "--user",
    user,
    "-e",
    "HOME=/tmp",
    "-v",
    `${cwd}:${cwd}`,
    "-w",
    cwd,
    resolveImage(spec.image, cwd),
    "bash",
    "-c",
    cmd,
  ];
}

// An agent stage in a container (machine.json `agentRuntime`): a writable root, since agents keep
// caches, and the network the spec names, since the agent calls its model.
export function dockerAgentArgs(
  spec: DockerSpec,
  run: AgentInVm,
  forward: readonly string[],
  user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
): string[] {
  const command = run.stdinFile ? ["bash", "-c", 'exec "$@" < "$0"', run.stdinFile, ...run.argv] : [...run.argv];
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    run.name,
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    spec.network ?? "none",
    "--memory",
    spec.memory ?? "4g",
    "--cpus",
    String(spec.cpus ?? 2),
    "--pids-limit",
    String(spec.pids ?? 512),
    ...(spec.runtime ? ["--runtime", spec.runtime] : []),
    "--user",
    user,
    "-e",
    "HOME=/tmp",
    "-v",
    `${run.cwd}:${run.cwd}${run.readOnly ? ":ro" : ""}`,
    ...run.mounts.flatMap((d) => ["-v", `${d}:${d}`]),
    ...Object.entries(run.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...forward.flatMap((k) => ["-e", k]),
    "-w",
    run.cwd,
    resolveImage(spec.image, run.cwd),
    ...command,
  ];
}

export class DockerExecution implements ExecutionPort {
  constructor(private readonly spec: DockerSpec) {}
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    const proc = Bun.spawn(containerArgs(this.spec, cmd, cwd), {
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
}
