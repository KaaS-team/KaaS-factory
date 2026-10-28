// `factory runtime verify <name>`: one shared suite every runtime must pass, whoever wrote its
// adapter, plus the live health probe that `factory doctor` and the Settings page show.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck } from "./doctor";
import type { ExecResult, ExecutionPort } from "./ports/execution";
import { type SandboxCapabilities, SandboxUnsupported } from "./ports/sandbox";
import { type RuntimeSpec, runtimeSpecs, runtimesFrom } from "./runtimes";
import { sandboxProvider } from "./sandbox";

export interface KitCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly detail?: string;
}

// An adapter that ignores its signal still cannot hang the suite or the probe.
async function within(p: Promise<ExecResult>, ms: number): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ExecResult>((r) => {
    timer = setTimeout(() => r({ stdout: "", stderr: "", code: 1, runtimeFailed: `no answer in ${ms} ms` }), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const said = (r: ExecResult) =>
  r.runtimeFailed ??
  `code ${r.code}, stdout ${JSON.stringify(r.stdout.slice(0, 200))}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`;

export async function verifyRuntime(
  port: ExecutionPort,
  capabilities: SandboxCapabilities,
  timeoutMs = 120_000,
): Promise<KitCheck[]> {
  const root = mkdtempSync(join(tmpdir(), "factory-kit-"));
  const provider = sandboxProvider(port, capabilities, root);
  const checks: KitCheck[] = [];
  const check = async (name: string, body: () => Promise<string | undefined>, skip = false) => {
    if (skip) return void checks.push({ name, ok: true, skipped: true });
    try {
      const problem = await body();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const box = await provider.create({ env: { KIT_GREETING: "hello kit" } });
  const run = (cmd: string) => within(box.exec(cmd, AbortSignal.timeout(timeoutMs)), timeoutMs);
  try {
    await check("runs a bash command and returns its stdout", async () => {
      const r = await run("echo kit-$((40 + 2))");
      return r.code === 0 && r.stdout.includes("kit-42") ? undefined : said(r);
    });
    await check("passes the command's exit code through", async () => {
      const r = await run("exit 7");
      return r.code === 7 && !r.runtimeFailed ? undefined : said(r);
    });
    await check("keeps stderr apart from stdout", async () => {
      const r = await run("echo kit-out; echo kit-err >&2");
      return r.stdout.includes("kit-out") && !r.stdout.includes("kit-err") && r.stderr.includes("kit-err")
        ? undefined
        : said(r);
    });
    await check("runs in the sandbox's files, with its env", async () => {
      await box.files.put("kit/marker.txt", "kit-marker");
      const r = await run('cat kit/marker.txt; echo " $KIT_GREETING"');
      return r.stdout.includes("kit-marker hello kit") ? undefined : said(r);
    });
    await check(
      "has no network when it says egress is denied",
      async () => {
        const r = await run("(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo kit-open || echo kit-closed");
        return r.stdout.includes("kit-closed") ? undefined : `reached 1.1.1.1:443 (${said(r)})`;
      },
      capabilities.egress !== "deny",
    );
    await check("files put, get and list round-trip", async () => {
      await box.files.put("kit/a.txt", "alpha");
      const got = new TextDecoder().decode(await box.files.get("kit/a.txt"));
      const listed = await box.files.list("kit");
      return got === "alpha" && listed.includes("a.txt") ? undefined : `got ${got}, listed ${listed.join(", ")}`;
    });
    await check("a snapshot restores into a new sandbox", async () => {
      const snap = await box.snapshot();
      const copy = await provider.create({ snapshot: snap });
      const r = await within(copy.exec("cat kit/a.txt"), timeoutMs);
      await copy.destroy();
      return r.stdout.includes("alpha") ? undefined : said(r);
    });
    await check("pause refuses commands until resume, and says whether memory was kept", async () => {
      const { memoryKept } = await box.pause();
      if (memoryKept !== capabilities.memoryResume)
        return `memoryKept ${memoryKept}, flag ${capabilities.memoryResume}`;
      if ((await box.status()) !== "paused") return `status ${await box.status()} after pause`;
      const refused = await box.exec("true").then(
        () => false,
        () => true,
      );
      await box.resume();
      const r = await run("echo kit-back");
      return refused && r.stdout.includes("kit-back") ? undefined : `refused while paused: ${refused}; ${said(r)}`;
    });
    await check("expose matches its flag", async () => {
      const url = await box.expose(8080).catch((e: unknown) => (e instanceof SandboxUnsupported ? undefined : e));
      if (url instanceof Error) return url.message;
      return (url !== undefined) === capabilities.expose
        ? undefined
        : `expose gave ${url}, flag ${capabilities.expose}`;
    });
    await check("destroy removes it", async () => {
      await box.destroy();
      return (await box.status()) === "destroyed" ? undefined : `status ${await box.status()}`;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return checks;
}

export interface Health {
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

// agent37 wakes a sleeping instance in 5 to 15 s, then writes its checkpoint: 45 s covers both.
export function probeBudgetMs(kind: string | undefined, other = 15_000): number {
  return kind === "agent37" ? 45_000 : other;
}

// Reachability, not correctness: one trivial command in an empty directory, within `timeoutMs`.
export async function probeRuntime(port: ExecutionPort, timeoutMs = 15_000): Promise<Health> {
  const dir = mkdtempSync(join(tmpdir(), "factory-probe-"));
  const start = Date.now();
  try {
    const r = await within(
      port
        .run("echo factory-probe-ok", dir, AbortSignal.timeout(timeoutMs))
        .catch((e: unknown): ExecResult => ({ stdout: "", stderr: "", code: 1, runtimeFailed: String(e) })),
      timeoutMs,
    );
    const ok = r.code === 0 && r.stdout.includes("factory-probe-ok");
    const why = r.runtimeFailed ?? (r.stderr.trim().split("\n")[0] || `exit ${r.code}`);
    return { ok, ms: Date.now() - start, detail: ok ? "answered" : why.slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The probe doctor, the dashboard and `runtime list` share: the named runtime of this machine,
// within its kind's budget (`other` for every kind but agent37).
export function probeNamed(
  machine: Readonly<Record<string, RuntimeSpec>> | undefined,
  name: string,
  other?: number,
  probe: (port: ExecutionPort, timeoutMs: number) => Promise<Health> = probeRuntime,
): Promise<Health> {
  return probe(runtimesFrom(machine)[name]!, probeBudgetMs(runtimeSpecs(machine)[name]?.kind, other));
}

export function formatKit(name: string, checks: readonly KitCheck[]): string {
  const failed = checks.filter((c) => !c.ok).length;
  return [
    ...checks.map((c) => `${c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`),
    failed ? `runtime ${name}: ${failed} of ${checks.length} checks failed` : `runtime ${name}: every check passed`,
  ].join("\n");
}

// `factory doctor`'s reachability rows: one probe per runtime the config or workflow names and this
// machine has (an unknown name already fails the check before it), run side by side.
export async function probeChecks(
  refs: readonly { name: string }[],
  known: readonly string[],
  probe: (runtime: string) => Promise<Health>,
): Promise<DoctorCheck[]> {
  const names = [...new Set(refs.map((r) => r.name))].filter((n) => known.includes(n));
  return Promise.all(
    names.map(async (name) => {
      const h = await probe(name);
      const detail = h.ok ? `answered in ${h.ms} ms` : `did not answer: ${h.detail}`;
      return { name: `runtime ${name} answers`, ok: h.ok, detail, fixable: false };
    }),
  );
}
