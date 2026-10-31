// A throwaway copy of the repo for the checks that mutate files, with node_modules linked, not copied.

import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const SKIP = new Set(["node_modules", ".git", ".worktrees", ".factory-state", "workspaces", "artifacts"]);

export function copyRepo(root = ROOT, prefix = "factory-mutant-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(root, dir, { recursive: true, filter: (src) => !SKIP.has(src.slice(root.length + 1).split("/")[0]!) });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  return dir;
}
