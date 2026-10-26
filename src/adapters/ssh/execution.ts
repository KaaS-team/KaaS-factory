// ExecutionPort on any machine you can ssh to: rsync the worktree to
// <dir>/<worktree name> on the host, then run the command there. The host
// needs bash, rsync and the repo's toolchain. `.git` is not copied (a
// worktree's .git points at this machine's clone), nor is anything in
// `exclude` (node_modules by default: the host installs its own).

import { basename } from "node:path";
import { shq } from "../../core/frame";
import { resolveImage } from "../../images";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface SshSpec {
  readonly kind: "ssh";
  readonly host: string;
  readonly dir: string;
  readonly exclude?: readonly string[];
  // Run in this image on the host (docker there), "auto" for the repo's language image, so the
  // host needs docker instead of every repo's toolchain.
  readonly image?: string;
}

export function sshArgs(spec: SshSpec, cmd: string, cwd: string): { sync: string[]; run: string[] } {
  const remote = `${spec.dir.replace(/\/$/, "")}/${basename(cwd)}`;
  const excludes = [".git", ...(spec.exclude ?? ["node_modules"])].map((x) => `--exclude=${x}`);
  return {
    // --rsync-path creates the directory first; openrsync (macOS) has no --mkpath.
    sync: [
      "rsync",
      "-a",
      "--delete",
      ...excludes,
      "-e",
      "ssh -o BatchMode=yes",
      "--rsync-path",
      `mkdir -p ${shq(remote)} && rsync`,
      `${cwd}/`,
      `${spec.host}:${remote}/`,
    ],
    // ssh joins its arguments into one remote shell line, so the whole command is one quoted word.
    run: [
      "ssh",
      "-o",
      "BatchMode=yes",
      spec.host,
      spec.image
        ? inImage(resolveImage(spec.image, cwd), remote, cmd)
        : `bash -c ${shq(`cd ${shq(remote)} && ${cmd}`)}`,
    ],
  };
}

function inImage(image: string, dir: string, cmd: string): string {
  return ["docker", "run", "--rm", "-v", `${dir}:${dir}`, "-w", dir, image, "bash", "-c", cmd].map(shq).join(" ");
}

async function spawn(argv: string[], cwd: string): Promise<ExecResult> {
  const proc = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

export class SshExecution implements ExecutionPort {
  constructor(private readonly spec: SshSpec) {}
  async run(cmd: string, cwd: string): Promise<ExecResult> {
    const { sync, run } = sshArgs(this.spec, cmd, cwd);
    const synced = await spawn(sync, cwd);
    if (synced.code !== 0)
      return { stdout: "", stderr: `rsync to ${this.spec.host} failed:\n${synced.stderr}`, code: synced.code };
    return spawn(run, cwd);
  }
}
