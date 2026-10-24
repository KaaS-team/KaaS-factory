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

export function portEnv(worktree: string | undefined): { FACTORY_PORT?: string } {
  const port = worktree ? worktreePort(worktree) : undefined;
  return port ? { FACTORY_PORT: String(port) } : {};
}
