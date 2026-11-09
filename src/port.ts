// FACTORY_PORT: each worktree gets its own free TCP port, so concurrent
// builds of an app that binds a port (a dev server, an e2e test) never
// collide. Stored in the worktree's own git dir, so it is stable across
// stages and never shows up in the diff. A port another worktree of the same
// clone already holds is never handed out again.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const FILE = "factory-port";

// `<worktree>/.git` is a file naming the worktree's git dir; in the main checkout it is the dir.
function gitDirOf(worktree: string): string | undefined {
  const dotGit = join(worktree, ".git");
  if (!existsSync(dotGit)) return undefined;
  if (statSync(dotGit).isDirectory()) return dotGit;
  const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
  return match ? resolve(worktree, match[1]!.trim()) : undefined;
}

function readPort(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const port = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

// Ports the clone's other worktrees hold: <common>/worktrees/*/factory-port.
function heldPorts(gitDir: string): Set<number> {
  const common = existsSync(join(gitDir, "commondir"))
    ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
    : gitDir;
  const worktrees = join(common, "worktrees");
  const dirs = [common, ...(existsSync(worktrees) ? readdirSync(worktrees).map((d) => join(worktrees, d)) : [])];
  return new Set(dirs.map((d) => readPort(join(d, FILE))).filter((p): p is number => p !== undefined));
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// The worktree's port, allocated on first ask; undefined outside a git checkout.
export function worktreePort(worktree: string, pick: () => number = freePort): number | undefined {
  const gitDir = gitDirOf(worktree);
  if (!gitDir) return undefined;
  const file = join(gitDir, FILE);
  const existing = readPort(file);
  if (existing !== undefined) return existing;
  const held = heldPorts(gitDir);
  let port = pick();
  for (let tries = 0; held.has(port) && tries < 20; tries++) port = pick();
  if (held.has(port)) return undefined;
  if (existsSync(dirname(file))) writeFileSync(file, `${port}\n`);
  return port;
}

// Bun.serve reports a taken port as EADDRINUSE or "... in use"; anything else is a real failure.
function isAddrInUse(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as { code?: string }).code === "EADDRINUSE" || /in use/i.test(err.message);
}

// How many ports above the default the dashboard tries before giving up.
export const DASHBOARD_PORT_TRIES = 20;

// Bun types a server's port as optional; a TCP server always has one.
type DashboardServer = ReturnType<typeof Bun.serve> & { port: number };

// The default port, or the next free one above it. An explicit port is never swapped: one try, then throw.
export function listenDashboard(opts: {
  hostname: string;
  port: number;
  explicit: boolean;
  fetch: (req: Request, server: DashboardServer) => Promise<Response>;
}): DashboardServer {
  const tries = opts.explicit ? 1 : DASHBOARD_PORT_TRIES;
  for (let i = 0; i < tries; i++) {
    let server!: DashboardServer;
    try {
      server = Bun.serve({
        hostname: opts.hostname,
        port: opts.port + i,
        fetch: (req) => opts.fetch(req, server),
      }) as DashboardServer;
      return server;
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
    }
  }
  if (opts.explicit)
    throw new Error(`port ${opts.port} is in use (set by --port or FACTORY_DASHBOARD_PORT); pick another`);
  throw new Error(`ports ${opts.port}-${opts.port + tries - 1} are all in use`);
}

export function portEnv(worktree: string | undefined): { FACTORY_PORT?: string } {
  const port = worktree ? worktreePort(worktree) : undefined;
  return port ? { FACTORY_PORT: String(port) } : {};
}
