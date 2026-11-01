// Neutralising config for every git call the runner makes inside a worktree an
// agent has written to: a planted fsmonitor, hooks path or ext transport must
// not run code from the runner's own `status` or `commit`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.ext.allow=never",
];

export function safeArgs(args: string[]): string[] {
  const has = SAFE_CONFIG.every((v, i) => args[i] === v);
  return has ? args : [...SAFE_CONFIG, ...args];
}

function bytesOf(path: string): Buffer {
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}

// sha256 over config, config.worktree and the hooks directory. A missing file
// hashes as empty, so the value is stable for a repo that never had one.
export function configFingerprint(gitDir: string): string {
  const h = createHash("sha256");
  const part = (label: string, data: Buffer) => {
    h.update(`${label}\0${data.length}\0`);
    h.update(data);
  };
  part("config", bytesOf(join(gitDir, "config")));
  part("config.worktree", bytesOf(join(gitDir, "config.worktree")));
  const dir = join(gitDir, "hooks/");
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  for (const name of names) part(`hook:${name}`, bytesOf(join(dir, name)));
  return h.digest("hex");
}
