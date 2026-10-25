// ExecutionPort on an agent37 instance (agent37.com), through its exec API:
//
//   POST <url>/v1/instances/<instance>/exec   X-Agent37-Key: <value of env var tokenEnv>
//   {"command": "<sh command>"}  ->  200 {"exit_code": 0, "stdout": "...", "stderr": "..."}
//
// An exec body is capped at 128 KB and the instance's file API only answers on
// templates that run an agent, so the worktree goes over exec itself: its
// tar.gz in base64 chunks appended to one file, then unpacked into a fresh
// directory under `root`, where `bash -c cmd` runs and which is removed after.
// `.git` and `exclude` (node_modules by default) are not sent. The token is
// read from the environment by name when the step runs, so it is never in
// machine.json, an argv or a log.

import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface Agent37Spec {
  readonly kind: "agent37";
  readonly instance: string;
  readonly tokenEnv: string;
  // The exec host; tests point it at a loopback fixture.
  readonly url?: string;
  // Where each run's directory goes on the instance.
  readonly root?: string;
  readonly exclude?: readonly string[];
}

export const AGENT37_URL = "https://sandbox.agent37.app";
// Base64 per exec, under the 128 KB body cap with room for the JSON around it.
export const CHUNK = 96 * 1024;

export function archiveArgs(spec: Agent37Spec): string[] {
  const excludes = [".git", ...(spec.exclude ?? ["node_modules"])].map((x) => `--exclude=./${x}`);
  return ["tar", "-czf", "-", ...excludes, "."];
}

function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function fail(stderr: string): ExecResult {
  return { stdout: "", stderr, code: 1, runtimeFailed: stderr.split("\n")[0]! };
}

export class Agent37Execution implements ExecutionPort {
  constructor(
    private readonly spec: Agent37Spec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private get where(): string {
    return `agent37 ${this.spec.instance}`;
  }

  // One exec; a string is a runtime failure, an object is the command's answer.
  private async exec(token: string, command: string, signal?: AbortSignal): Promise<ExecResult | string> {
    const url = `${this.spec.url ?? AGENT37_URL}/v1/instances/${this.spec.instance}/exec`;
    let res: Response;
    let text: string;
    try {
      // A long command sends nothing until it ends; Bun's own idle timeout would drop it.
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent37-key": token },
        body: JSON.stringify({ command }),
        timeout: false,
        ...(signal ? { signal } : {}),
      } as RequestInit);
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) return `${this.where}: cut off (${String(signal.reason)})`;
      return `${this.where} unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!res.ok) return `${this.where} answered ${res.status}: ${text.slice(0, 500)}`;
    try {
      const r = JSON.parse(text) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof r.stdout === "string" && typeof r.stderr === "string" && Number.isInteger(r.exit_code))
        return { stdout: r.stdout, stderr: r.stderr, code: r.exit_code as number };
    } catch {
      // falls through to the shape error
    }
    return `${this.where} answered without {exit_code, stdout, stderr}: ${text.slice(0, 500)}`;
  }

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const token = this.env[this.spec.tokenEnv];
    if (!token) return fail(`${this.where}: env var ${this.spec.tokenEnv} is not set`);
    const tar = Bun.spawn(archiveArgs(this.spec), { cwd, stdout: "pipe", stderr: "pipe" });
    const [archive, tarErr, tarCode] = await Promise.all([
      new Response(tar.stdout).arrayBuffer(),
      new Response(tar.stderr).text(),
      tar.exited,
    ]);
    if (tarCode !== 0) return fail(`packing the worktree failed:\n${tarErr}`);
    const b64 = Buffer.from(archive).toString("base64");
    const dir = `${this.spec.root ?? "/tmp/factory"}/${crypto.randomUUID()}`;
    const setup = await this.exec(token, `mkdir -p ${quote(dir)} && : > ${quote(`${dir}.b64`)}`, signal);
    if (typeof setup === "string") return fail(setup);
    if (setup.code !== 0) return fail(`${this.where}: making ${dir} failed:\n${setup.stderr}`);
    try {
      for (let i = 0; i < b64.length; i += CHUNK) {
        // Base64 has no quote in it, so a chunk goes in single quotes as is.
        const r = await this.exec(token, `printf %s '${b64.slice(i, i + CHUNK)}' >> ${quote(`${dir}.b64`)}`, signal);
        if (typeof r === "string") return fail(r);
        if (r.code !== 0) return fail(`${this.where}: sending the worktree failed:\n${r.stderr}`);
      }
      const unpack = await this.exec(token, `base64 -d < ${quote(`${dir}.b64`)} | tar -xzf - -C ${quote(dir)}`, signal);
      if (typeof unpack === "string") return fail(unpack);
      if (unpack.code !== 0) return fail(`${this.where}: unpacking the worktree failed:\n${unpack.stderr}`);
      const r = await this.exec(token, `cd ${quote(dir)} && bash -c ${quote(cmd)}`, signal);
      return typeof r === "string" ? fail(r) : r;
    } finally {
      // Best effort: a cut-off run's directory is left for the next boot's /tmp.
      if (!signal?.aborted) await this.exec(token, `rm -rf ${quote(dir)} ${quote(`${dir}.b64`)}`);
    }
  }
}
