// ExecutionPort on a hosted sandbox behind HTTP (e2b, Daytona, Modal or your
// own), through one small protocol a shim in front of any of them can speak:
//
//   POST <url>   Authorization: Bearer <the value of env var tokenEnv>
//   {"cmd": "<bash command>", "archive": "<base64 tar.gz of the worktree>"}
//   -> 200 {"stdout": "...", "stderr": "...", "code": 0}
//
// The sandbox unpacks the archive, runs `bash -c cmd` in it and answers.
// `.git` and `exclude` (node_modules by default) are not sent. The token is
// read from the environment by name when the step runs, so it is never in
// machine.json, an argv or a log.

import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface HttpSandboxSpec {
  readonly kind: "http";
  readonly url: string;
  readonly tokenEnv?: string;
  readonly exclude?: readonly string[];
}

export function archiveArgs(spec: HttpSandboxSpec): string[] {
  const excludes = [".git", ...(spec.exclude ?? ["node_modules"])].map((x) => `--exclude=./${x}`);
  return ["tar", "-czf", "-", ...excludes, "."];
}

function fail(stderr: string): ExecResult {
  return { stdout: "", stderr, code: 1, runtimeFailed: stderr.split("\n")[0]! };
}

export class HttpSandboxExecution implements ExecutionPort {
  constructor(
    private readonly spec: HttpSandboxSpec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const tar = Bun.spawn(archiveArgs(this.spec), { cwd, stdout: "pipe", stderr: "pipe" });
    const [archive, tarErr, tarCode] = await Promise.all([
      new Response(tar.stdout).arrayBuffer(),
      new Response(tar.stderr).text(),
      tar.exited,
    ]);
    if (tarCode !== 0) return fail(`packing the worktree failed:\n${tarErr}`);
    const token = this.spec.tokenEnv ? this.env[this.spec.tokenEnv] : undefined;
    if (this.spec.tokenEnv && !token) return fail(`sandbox ${this.spec.url}: env var ${this.spec.tokenEnv} is not set`);
    let res: Response;
    try {
      res = await fetch(this.spec.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ cmd, archive: Buffer.from(archive).toString("base64") }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) return fail(`sandbox ${this.spec.url}: cut off (${String(signal.reason)})`);
      return fail(`sandbox ${this.spec.url} unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return fail(`sandbox ${this.spec.url}: cut off (${String(signal?.reason)})`);
    }
    if (!res.ok) return fail(`sandbox ${this.spec.url} answered ${res.status}: ${text.slice(0, 500)}`);
    try {
      const r = JSON.parse(text) as Partial<ExecResult>;
      if (typeof r.stdout === "string" && typeof r.stderr === "string" && Number.isInteger(r.code))
        return { stdout: r.stdout, stderr: r.stderr, code: r.code! };
    } catch {
      // falls through to the shape error
    }
    return fail(`sandbox ${this.spec.url} answered without {stdout, stderr, code}: ${text.slice(0, 500)}`);
  }
}
