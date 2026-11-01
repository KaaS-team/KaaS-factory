// A check whose inputs hash the same as a green run replays that run's output instead of running again.
// Any changed input (a tracked or new file, the command, the tool versions) misses; only a zero exit is stored.
// Usage: bun scripts/check-cache.ts <name> [--in <pathspec>]... [--out <path>]... -- <cmd...>

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const KEEP = 5;

const USAGE = "usage: bun scripts/check-cache.ts <name> [--in <pathspec>]... [--out <path>]... -- <cmd...>";

export interface Parsed {
  readonly name: string;
  readonly ins: string[];
  readonly outs: string[];
  readonly argv: string[];
}

export interface Options extends Parsed {
  readonly root: string;
  readonly env: Record<string, string | undefined>;
}

interface Entry {
  readonly name: string;
  readonly key: string;
  readonly at: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly outs: Record<string, string>;
}

export function parseArgs(argv: readonly string[]): Parsed | undefined {
  const dash = argv.indexOf("--");
  const name = argv[0];
  if (dash < 1 || dash === argv.length - 1 || name === undefined || !/^[a-z0-9-]+$/.test(name)) return undefined;
  const ins: string[] = [];
  const outs: string[] = [];
  const flags = argv.slice(1, dash);
  for (let i = 0; i < flags.length; i += 2) {
    const value = flags[i + 1];
    if (value === undefined) return undefined;
    if (flags[i] === "--in") ins.push(value);
    else if (flags[i] === "--out") outs.push(value);
    else return undefined;
  }
  return { name, ins, outs, argv: argv.slice(dash + 1) };
}

function run(cmd: string[], cwd: string, input?: string): string {
  const p = Bun.spawnSync(cmd, {
    cwd,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

export function inputFiles(root: string, pathspecs: readonly string[], outs: readonly string[]): string[] {
  const listed = run(
    ["git", "ls-files", "-co", "--exclude-standard", "-z", "--", ...(pathspecs.length ? pathspecs : ["."])],
    root,
  );
  const skip = new Set(outs);
  return listed
    .split("\0")
    .filter((f) => f !== "" && !skip.has(f) && !f.includes("\n") && existsSync(join(root, f)))
    .sort();
}

export function cacheKey(o: Options): string {
  const inputs = inputFiles(o.root, o.ins, o.outs);
  const blobs = inputs.length
    ? run(["git", "hash-object", "--stdin-paths"], o.root, `${inputs.join("\n")}\n`).split("\n")
    : [];
  const first = o.argv[0] ?? "";
  let tool = "";
  if (first !== "bun") {
    const v = Bun.spawnSync([first, "--version"], { cwd: o.root, stdout: "pipe", stderr: "ignore" });
    tool = v.exitCode === 0 ? (v.stdout.toString().split("\n")[0] ?? "") : "";
  }
  const material = {
    name: o.name,
    argv: o.argv,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    tool,
    files: inputs.map((f, i) => [f, blobs[i]]),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function shouldCache(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  return env.CHECK_CACHE !== "off" && !argv.some((a) => a.startsWith("--rerun-each"));
}

export function prune(dir: string, name: string, keep = KEEP): void {
  if (!existsSync(dir)) return;
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of mine.slice(keep)) rmSync(join(dir, f), { force: true });
}

function note(env: Record<string, string | undefined>, line: string): void {
  console.error(`check-cache: ${line}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- check-cache: ${line}\n`);
}

export async function runCached(o: Options): Promise<number> {
  const key = cacheKey(o);
  const dir = o.env.CHECK_CACHE_DIR ?? join(o.root, "reports/check-cache");
  const path = join(dir, `${o.name}-${key}.json`);
  // biome-ignore format: the mutation in tests/mutations.json anchors on this exact line
  const hit = shouldCache(o.argv, o.env) && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Entry) : undefined;
  if (hit) {
    for (const [file, b64] of Object.entries(hit.outs)) {
      mkdirSync(dirname(join(o.root, file)), { recursive: true });
      writeFileSync(join(o.root, file), Buffer.from(b64, "base64"));
    }
    process.stdout.write(hit.stdout);
    process.stderr.write(hit.stderr);
    note(o.env, `hit ${o.name} ${key.slice(0, 12)}`);
    return 0;
  }
  note(o.env, `miss ${o.name} ${key.slice(0, 12)}`);
  const proc = Bun.spawn(o.argv, { cwd: o.root, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (code === 0 && shouldCache(o.argv, o.env)) {
    const outs: Record<string, string> = {};
    for (const f of o.outs) if (existsSync(join(o.root, f))) outs[f] = readFileSync(join(o.root, f)).toString("base64");
    mkdirSync(dir, { recursive: true });
    const entry: Entry = { name: o.name, key, at: new Date().toISOString(), stdout, stderr, outs };
    writeFileSync(path, JSON.stringify(entry));
    prune(dir, o.name);
  }
  return code;
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(await runCached({ ...parsed, root: process.cwd(), env: process.env }));
}
