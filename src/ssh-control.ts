// Remote control of a factory host over the stdin and stdout of an ssh session: the host opens no
// port and holds no shared token, so whoever may ssh in as the owner may control it, and nobody else.
// The protocol is one JSON object per line; `serveControl` is the host half, `connectControl` the client.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { discoverRepos, livePath } from "./paths";
import { type LiveStage, readLive } from "./takeover";

export type ControlRequest =
  | { readonly op: "list" }
  | { readonly op: "cancel"; readonly repo: string; readonly issue: number };

export interface ControlRun {
  readonly repo: string;
  readonly issue: number;
  readonly stage: string;
  readonly agent: string;
}

export type ControlReply =
  | { readonly ok: true; readonly runs?: readonly ControlRun[]; readonly cancelled?: boolean }
  | { readonly ok: false; readonly error: string };

export interface ControlDeps {
  list(): readonly ControlRun[];
  cancel(repo: string, issue: number): boolean;
}

export function hostControl(env: NodeJS.ProcessEnv = process.env): ControlDeps {
  const liveOf = (repo: string, issue: number): LiveStage | undefined => readLive(livePath(repo, issue, env));
  return {
    list: () =>
      discoverRepos(env).flatMap((repo) => {
        const dir = dirname(livePath(repo, 0, env));
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .map((f) => /^issue-(\d+)\.json$/.exec(f)?.[1])
          .flatMap((n) => {
            const live = n ? liveOf(repo, Number(n)) : undefined;
            return live ? [{ repo, issue: live.issue, stage: live.stage, agent: live.agent }] : [];
          });
      }),
    cancel: (repo, issue) => {
      const live = liveOf(repo, issue);
      if (!live) return false;
      try {
        process.kill(-live.pid, "SIGTERM");
      } catch {
        return false;
      }
      return true;
    },
  };
}

export function parseRequest(line: string): ControlRequest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "not JSON";
  }
  const r = raw as { op?: unknown; repo?: unknown; issue?: unknown };
  if (r.op === "list") return { op: "list" };
  if (r.op === "cancel" && typeof r.repo === "string" && Number.isInteger(r.issue))
    return { op: "cancel", repo: r.repo, issue: r.issue as number };
  return "unknown op";
}

export function answer(req: ControlRequest, deps: ControlDeps): ControlReply {
  if (req.op === "list") return { ok: true, runs: deps.list() };
  let cancelled: boolean;
  try {
    cancelled = deps.cancel(req.repo, req.issue);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return cancelled ? { ok: true, cancelled } : { ok: false, error: `no running stage for ${req.repo}#${req.issue}` };
}

// The host half: one reply line per request line, until stdin closes.
export async function serveControl(input: Readable, output: Writable, deps: ControlDeps): Promise<void> {
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    const req = parseRequest(line);
    const reply: ControlReply = typeof req === "string" ? { ok: false, error: req } : answer(req, deps);
    output.write(`${JSON.stringify(reply)}\n`);
  }
}

// A host starting with "-" would be read by ssh as an option (-oProxyCommand=...), so it is refused.
export function sshArgv(host: string): string[] {
  if (!host || host.startsWith("-") || /\s/.test(host))
    throw new Error(`not a valid ssh host: ${JSON.stringify(host)}`);
  return ["ssh", "-T", "-o", "BatchMode=yes", host, "factory", "runner", "control-serve"];
}

// The client half: spawn ssh (or any argv, for tests), send one request, read one reply.
export function connectControl(argv: readonly string[], req: ControlRequest): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      child.kill();
      fn();
    };
    createInterface({ input: child.stdout }).once("line", (line) =>
      finish(() => {
        try {
          resolve(JSON.parse(line) as ControlReply);
        } catch {
          reject(new Error("the host sent something that is not a control reply"));
        }
      }),
    );
    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", (code) => finish(() => reject(new Error(`ssh exited ${code} before answering`))));
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

// `factory runner control <host> list | cancel <owner/name> <issue>`, and the host side `control-serve`.
export async function controlCommand(argv: readonly string[]): Promise<void> {
  if (argv[0] === "control-serve") return serveControl(process.stdin, process.stdout, hostControl());
  const [, host, op, repo, issue] = argv;
  const req: ControlRequest | undefined =
    op === "list"
      ? { op: "list" }
      : op === "cancel" && repo && issue
        ? { op: "cancel", repo, issue: Number(issue) }
        : undefined;
  if (!host || !req) throw new Error("runner control <host> list | cancel <owner/name> <issue>");
  const reply = await connectControl(sshArgv(host), req);
  if (!reply.ok) throw new Error(reply.error);
  if (reply.runs) for (const r of reply.runs) console.log(`${r.repo}#${r.issue}\t${r.stage}\t${r.agent}`);
  if (reply.cancelled) console.log(`cancelled ${repo}#${issue}`);
}
