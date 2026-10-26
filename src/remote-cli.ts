// `factory mcp`, `factory runner` and `factory pair`: the commands that let the factory be driven
// from somewhere other than this terminal. Kept out of cli.ts, which sits at its size limit.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EnvSecrets } from "./adapters/env/secrets";
import { SseEventSource } from "./adapters/sse/event-source";
import { runDir } from "./artifacts";
import { UsageError } from "./cli-output";
import { DEFAULT_CONFIG, loadConfig } from "./config";
import { createMcpServer, serveStdio } from "./mcp-server";
import { factoryHome, livePath } from "./paths";
import { encodeQr, qrToTerminal } from "./qr";
import { dialOut, registerRunner, type RunnerCreds, type RunnerWork } from "./runner-channel";
import { makeScm } from "./scm";
import { readLive, stopRunningStage } from "./takeover";

export const RUNNER_FILE = "runner.json";
const BIN = join(import.meta.dir, "..", "bin", "factory");

function flagOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function repoOf(argv: readonly string[], cmd: string) {
  const repoDir = flagOf(argv, "repo-dir");
  const config = repoDir ? await loadConfig(resolve(repoDir)) : undefined;
  const repo = flagOf(argv, "repo") ?? process.env.FACTORY_REPO ?? config?.repo;
  if (!repo) throw new UsageError(`${cmd}: --repo <owner/name>, --repo-dir <path> or FACTORY_REPO is required`);
  return { repo, repoDir: resolve(repoDir ?? "."), github: makeScm(config ?? DEFAULT_CONFIG) };
}

// The secret is a credential, so it is read from stdin, never from argv where `ps` shows it.
async function stdinLine(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

export function runnerFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryHome(env), RUNNER_FILE);
}

function saveCreds(file: string, creds: RunnerCreds & { lastSeq?: number }): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

// The work a dialled-out runner does: the same `factory run` a local watcher would start.
export function runnerWork(repo: string, repoDir: string): RunnerWork {
  const children = new Map<number, ChildProcess>();
  return {
    run: (issue) =>
      new Promise((done) => {
        const child = spawn("bun", [BIN, "run", "--issue", String(issue), "--repo-dir", repoDir], { stdio: "inherit" });
        children.set(issue, child);
        child.on("exit", () => {
          children.delete(issue);
          done();
        });
      }),
    deliver: async (issue, text) => {
      const dir = join(repoDir, runDir(issue));
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "messages.md"), `- ${new Date().toISOString()}: ${text.replace(/\n/g, " ")}\n`);
    },
    stop: async (issue, kind) => {
      const live = readLive(livePath(repo, issue));
      // Takeover leaves the session resumable for a human; cancel ends the whole run.
      if (kind === "takeover" && live) await stopRunningStage(livePath(repo, issue), live);
      else children.get(issue)?.kill("SIGTERM");
    },
  };
}

async function cmdRunner(argv: readonly string[]): Promise<void> {
  const file = runnerFile();
  if (argv[1] === "register") {
    const url = flagOf(argv, "url");
    if (!url) throw new UsageError("runner register: --url <plane> is required; the one-time token is read from stdin");
    const creds = await registerRunner(url, await stdinLine(), flagOf(argv, "name") ?? hostname());
    saveCreds(file, creds);
    console.log(`registered as ${creds.id}; run \`factory runner start\` to dial out`);
    return;
  }
  if (argv[1] !== "start")
    throw new UsageError("runner: register --url <plane> [--name <n>] | start --repo-dir <path>");
  if (!existsSync(file))
    throw new UsageError("runner start: not registered; run `factory runner register --url <plane>` first");
  const creds = JSON.parse(readFileSync(file, "utf8")) as RunnerCreds & { lastSeq?: number };
  const { repo, repoDir } = await repoOf(argv, "runner start");
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const source = new SseEventSource(`${creds.url}/runner/stream`, () => creds.secret);
  const link = dialOut(creds, runnerWork(repo, repoDir), { source, signal: controller.signal, after: creds.lastSeq });
  console.log(`dialled out to ${creds.url} as ${creds.id}`);
  await link.done;
  saveCreds(file, { ...creds, lastSeq: link.lastSeq() });
}

async function cmdPair(argv: readonly string[]): Promise<void> {
  const url = flagOf(argv, "url")?.replace(/\/+$/, "");
  const login = flagOf(argv, "login");
  if (!url || !login) throw new UsageError("pair: --url <plane> --login <member> are required");
  const token = new EnvSecrets().get("FACTORY_DASHBOARD_TOKEN");
  if (!token) throw new UsageError("pair: FACTORY_DASHBOARD_TOKEN must be set to the plane's break-glass token");
  const res = await fetch(`${url}/api/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: url },
    body: JSON.stringify({ login }),
  });
  const body = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
  if (!res.ok || !body.link) throw new Error(body.error ?? `the plane refused to pair: HTTP ${res.status}`);
  console.log(qrToTerminal(encodeQr(body.link)));
  console.log(`Scan with the phone, or open: ${body.link}`);
}

async function cmdMcp(argv: readonly string[]): Promise<void> {
  const { repo, github } = await repoOf(argv, "mcp");
  // stdout carries the protocol, so nothing else may print there.
  await serveStdio(createMcpServer({ github, repo, by: flagOf(argv, "as") ?? "the local owner" }));
}

export function remoteCommand(argv: readonly string[]): Promise<void> {
  if (argv[0] === "mcp") return cmdMcp(argv);
  if (argv[0] === "runner") return cmdRunner(argv);
  return cmdPair(argv);
}
