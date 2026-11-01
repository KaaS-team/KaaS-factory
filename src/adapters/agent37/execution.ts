// ExecutionPort on an agent37 instance (agent37.com), through its exec API:
//
//   POST <url>/v1/instances/<instance>/exec   X-Agent37-Key: <value of env var tokenEnv>
//   {"command": "<sh command>"}  ->  200 {"exit_code": 0, "stdout": "...", "stderr": "..."}
//
// An exec body is capped at 128 KB and the instance's file API only answers on
// templates that run an agent, so the worktree goes over exec itself: its
// tar.gz in base64 parts written side by side, joined, then unpacked into a fresh
// directory under `root`. There `bash -c cmd` runs detached and is polled for its exit code,
// because one exec answers 504 after 15 minutes while the command keeps running; the directory
// is removed after.
// `.git` and `exclude` (node_modules by default) are not sent. The token is
// read from the environment by name when the step runs, so it is never in
// machine.json, an argv or a log.

import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface Agent37Spec {
  readonly kind: "agent37";
  // One of `instance` or `instances`; naming both is a runtime problem at load.
  readonly instance?: string;
  readonly instances?: readonly string[];
  readonly tokenEnv: string;
  // The exec host; tests point it at a loopback fixture.
  readonly url?: string;
  // Where each run's directory goes on the instance.
  readonly root?: string;
  readonly exclude?: readonly string[];
  // The account API, for account(); tests point it at a loopback fixture.
  readonly apiUrl?: string;
}

export const AGENT37_API_URL = "https://api.agent37.com";
const TAIL = 512 * 1024;
const PARTS_IN_FLIGHT = 8;
const GATES = "FACTORY_GATES";

export const AGENT37_URL = "https://sandbox.agent37.app";
// Base64 per exec, under the 128 KB body cap with room for the JSON around it.
export const CHUNK = 96 * 1024;

export function archiveArgs(spec: Agent37Spec): string[] {
  const excludes = [".git", ...(spec.exclude ?? ["node_modules"])].map((x) => `--exclude=./${x}`);
  return ["tar", "-czf", "-", ...excludes, "."];
}

type Answer = ExecResult & { truncated?: boolean };
export type Account = { status: string; balance: number } | { reason: string };

export function accountLine(accounts: readonly Account[]): string {
  return accounts
    .map((a) =>
      "reason" in a ? `account unreadable: ${a.reason}` : `instance ${a.status}, wallet $${a.balance.toFixed(2)}`,
    )
    .join("; ");
}

function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function fail(stderr: string): ExecResult {
  return { stdout: "", stderr, code: 1, runtimeFailed: stderr.split("\n")[0]! };
}

// A sleeping instance answers 409 while it writes its checkpoint and 503 after a host move.
// Five waits, 31 s in all, cover a wake; the main command is never sent twice.
// The budget is shared by every retrying exec of one run(), so a flapping instance cannot stall it
// for minutes; tests shrink both.
export interface RetryTiming {
  readonly backoffMs: readonly number[];
  readonly budgetMs: number;
}
const RETRY: RetryTiming = { backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000], budgetMs: 60_000 };

function tryAgain(status: number, text: string): boolean {
  if (status !== 409 && status !== 503) return false;
  try {
    return (JSON.parse(text) as { error?: { code?: unknown } }).error?.code === "try_again";
  } catch {
    return false;
  }
}

// False when the signal aborts the wait.
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal?.aborted) return done(false);
    const onAbort = () => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      done(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Runs in flight per instance in this process, so each run takes the least busy one.
const inFlight = new Map<string, number>();

export class Agent37Execution implements ExecutionPort {
  constructor(
    private readonly spec: Agent37Spec,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly retry: RetryTiming = RETRY,
    private readonly pollMs = 5_000,
  ) {}

  get ids(): readonly string[] {
    return this.spec.instances ?? (this.spec.instance ? [this.spec.instance] : []);
  }

  private where(inst: string): string {
    return `agent37 ${inst}`;
  }

  // Fewest runs in flight, ties by order; taken before any await so concurrent runs see each other.
  private take(): string {
    const inst = this.ids.reduce((a, b) => ((inFlight.get(b) ?? 0) < (inFlight.get(a) ?? 0) ? b : a));
    inFlight.set(inst, (inFlight.get(inst) ?? 0) + 1);
    return inst;
  }

  // One exec; a string is a runtime failure, an object is the command's answer.
  // Only an exec given `retries` waits out a try_again; the start and the cleanup run once.
  private async exec(
    inst: string,
    token: string,
    command: string,
    signal?: AbortSignal,
    retries?: { spent: number },
  ): Promise<Answer | string> {
    const url = `${this.spec.url ?? AGENT37_URL}/v1/instances/${inst}/exec`;
    for (let wait = 0; ; wait++) {
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-agent37-key": token },
          body: JSON.stringify({ command }),
          timeout: false,
          ...(signal ? { signal } : {}),
        } as RequestInit);
        text = await res.text();
      } catch (err) {
        if (signal?.aborted) return `${this.where(inst)}: cut off (${String(signal.reason)})`;
        return `${this.where(inst)} unreachable: ${err instanceof Error ? err.message : String(err)}`;
      }
      const delay = this.retry.backoffMs[wait];
      if (
        retries &&
        delay !== undefined &&
        retries.spent + delay <= this.retry.budgetMs &&
        tryAgain(res.status, text)
      ) {
        retries.spent += delay;
        if (!(await pause(delay, signal))) return `${this.where(inst)}: cut off (${String(signal?.reason)})`;
        continue;
      }
      if (!res.ok) return `${this.where(inst)} answered ${res.status}: ${text.slice(0, 500)}`;
      try {
        const r = JSON.parse(text) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown; truncated?: unknown };
        if (typeof r.stdout === "string" && typeof r.stderr === "string" && Number.isInteger(r.exit_code))
          return { stdout: r.stdout, stderr: r.stderr, code: r.exit_code as number, truncated: r.truncated === true };
      } catch {
        // falls through to the shape error
      }
      return `${this.where(inst)} answered without {exit_code, stdout, stderr}: ${text.slice(0, 500)}`;
    }
  }

  // The instance's status and the wallet balance; a failure is returned as its reason, never thrown.
  async account(inst: string | undefined = this.ids[0]): Promise<Account> {
    const token = this.env[this.spec.tokenEnv];
    if (!token) return { reason: `env var ${this.spec.tokenEnv} is not set` };
    const base = this.spec.apiUrl ?? AGENT37_API_URL;
    const get = async (path: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    };
    try {
      const [instance, billing] = await Promise.all([get(`/v1/instances/${inst}`), get("/v1/billing")]);
      if (typeof instance.status !== "string" || typeof billing.balance !== "number")
        return { reason: "unexpected answer shape" };
      return { status: instance.status, balance: billing.balance };
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const token = this.env[this.spec.tokenEnv];
    if (!token) return fail(`${this.where(this.ids[0] ?? "")}: env var ${this.spec.tokenEnv} is not set`);
    const inst = this.take();
    try {
      return await this.runOn(inst, token, cmd, cwd, signal);
    } finally {
      inFlight.set(inst, (inFlight.get(inst) ?? 1) - 1);
    }
  }

  private async runOn(
    inst: string,
    token: string,
    cmd: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const where = this.where(inst);
    const tar = Bun.spawn(archiveArgs(this.spec), {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const [archive, tarErr, tarCode] = await Promise.all([
      new Response(tar.stdout).arrayBuffer(),
      new Response(tar.stderr).text(),
      tar.exited,
    ]);
    if (tarCode !== 0) return fail(`packing the worktree failed:\n${tarErr}`);
    const b64 = Buffer.from(archive).toString("base64");
    const root = this.spec.root ?? "/tmp/factory";
    const dir = `${root}/${crypto.randomUUID()}`;
    const retries = { spent: 0 };
    const x = (command: string, sig = signal, r?: { spent: number }) => this.exec(inst, token, command, sig, r);
    // Directories a sleeping instance never cleaned (an abort, a restart) are reaped by the next run.
    const setup = await x(
      `find ${quote(root)} -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} + 2>/dev/null; mkdir -p ${quote(dir)}`,
      signal,
      retries,
    );
    if (typeof setup === "string") return fail(setup);
    if (setup.code !== 0) return fail(`${where}: making ${dir} failed:\n${setup.stderr}`);
    try {
      const parts: string[] = [];
      for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
      let next = 0;
      let failure: ExecResult | undefined;
      const worker = async () => {
        while (!failure && next < parts.length) {
          const i = next++;
          // Base64 has no quote in it, so a part goes in single quotes as is.
          const r = await x(`printf %s '${parts[i]}' > ${quote(`${dir}.b64.${i}`)}`, signal, retries);
          if (typeof r === "string") failure ??= fail(r);
          else if (r.code !== 0) failure ??= fail(`${where}: sending the worktree failed:\n${r.stderr}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARTS_IN_FLIGHT, parts.length) }, worker));
      if (failure) return failure;
      const names = parts.map((_, i) => quote(`${dir}.b64.${i}`)).join(" ");
      const joined = await x(`cat ${names} > ${quote(`${dir}.b64`)}`, signal, retries);
      if (typeof joined === "string") return fail(joined);
      if (joined.code !== 0) return fail(`${where}: joining the parts failed:\n${joined.stderr}`);
      const unpack = await x(`base64 -d < ${quote(`${dir}.b64`)} | tar -xzf - -C ${quote(dir)}`, signal, retries);
      if (typeof unpack === "string") return fail(unpack);
      if (unpack.code !== 0) return fail(`${where}: unpacking the worktree failed:\n${unpack.stderr}`);
      return await this.detached(inst, x, cmd, dir, signal);
    } finally {
      // An abort may land while the start exec is still writing its pid, so the kill waits for it.
      // An aborted run kills its process group first; the cleanup itself ignores the aborted signal.
      if (signal?.aborted)
        await this.exec(
          inst,
          token,
          `i=0; while [ ! -s ${quote(`${dir}.pid`)} ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done; ` +
            `kill -s KILL $(cat ${quote(`${dir}.wpid`)}) 2>/dev/null; kill -s KILL -- -$(cat ${quote(`${dir}.pid`)}) 2>/dev/null; rm -rf ${quote(dir)}*`,
        );
      if (!signal?.aborted) await this.exec(inst, token, `rm -rf ${quote(dir)}*`);
    }
  }

  // Start the command in its own process group and poll for its exit code, one short exec per tick.
  private async detached(
    inst: string,
    x: (command: string, sig?: AbortSignal, r?: { spent: number }) => Promise<Answer | string>,
    cmd: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const f = (ext: string) => quote(`${dir}.${ext}`);
    const wrapper = `echo $$ > ${f("wpid")}; set -m; bash -c "$1" > ${f("out")} 2> ${f("err")} & echo $! > ${f("pid")}; wait $!; echo $? > ${f("code")}`;
    const start = await x(
      `(cd ${quote(dir)} && nohup bash -c ${quote(wrapper)} _ ${quote(cmd)}) > /dev/null 2>&1 < /dev/null & ` +
        `i=0; while [ ! -s ${f("pid")} ] && [ -d ${quote(dir)} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`,
      signal,
    );
    if (typeof start === "string") return fail(start);
    for (;;) {
      if (!(await pause(this.pollMs, signal))) return fail(`${this.where(inst)}: cut off (${String(signal?.reason)})`);
      const done = await x(`cat ${f("code")}`, signal, { spent: 0 });
      if (typeof done === "string") return fail(done);
      if (done.code !== 0 || !done.stdout.trim()) continue;
      const tail = (ext: string) =>
        `t=${f(`${ext}.t`)}; tail -c ${TAIL} ${f(ext)} > "$t"; grep -q '^${GATES}' "$t" || grep '^${GATES}' ${f(ext)} | tail -n 1 >> "$t"; cat "$t"`;
      const [out, err] = await Promise.all([
        x(tail("out"), signal, { spent: 0 }),
        x(tail("err"), signal, { spent: 0 }),
      ]);
      if (typeof out === "string") return fail(out);
      if (typeof err === "string") return fail(err);
      const note = out.truncated || err.truncated ? "agent37: output truncated at 512 KB per stream" : "";
      return {
        stdout: out.stdout,
        stderr: note ? `${err.stdout}${err.stdout && !err.stdout.endsWith("\n") ? "\n" : ""}${note}\n` : err.stdout,
        code: Number.parseInt(done.stdout.trim(), 10),
      };
    }
  }
}
