// A throwaway copy of the repo for the checks that mutate files, with node_modules linked, not copied.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const SKIP = new Set(["node_modules", ".git", ".worktrees", ".factory-state", "workspaces", "artifacts"]);

export function copyRepo(root = ROOT, prefix = "factory-mutant-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(root, dir, { recursive: true, filter: (src) => !SKIP.has(src.slice(root.length + 1).split("/")[0]!) });
  linkModules(root, dir);
  return dir;
}

// Workspace packages resolve through a relative link in node_modules, so a plain link to the real
// node_modules would hand a mutant the unmutated package. Those links are re-made inside the copy.
function linkModules(root: string, dir: string): void {
  const from = join(root, "node_modules");
  const to = join(dir, "node_modules");
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.name.startsWith("@") || !entry.isDirectory()) {
      symlinkSync(join(from, entry.name), join(to, entry.name));
      continue;
    }
    mkdirSync(join(to, entry.name));
    for (const pkg of readdirSync(join(from, entry.name), { withFileTypes: true })) {
      const real = join(from, entry.name, pkg.name);
      const target = pkg.isSymbolicLink() ? resolve(join(from, entry.name), readlinkSync(real)) : real;
      const inRepo = target.startsWith(`${root}/`) && !target.startsWith(`${from}/`);
      symlinkSync(inRepo ? join(dir, target.slice(root.length + 1)) : real, join(to, entry.name, pkg.name));
    }
  }
}
