// `factory install --update` must not clobber a file the repo edited. .factory/manifest.json holds
// the sha256 each factory file had when it was last installed; a file whose bytes now differ from
// that hash, and from the new template, is the repo's edit. A file with no manifest entry cannot be
// told apart from a stale copy, so it is not guarded.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Manifest = ReadonlyMap<string, string>;

export function readManifest(base: string): Manifest {
  const path = join(base, ".factory", "manifest.json");
  if (!existsSync(path)) return new Map();
  try {
    const files = JSON.parse(readFileSync(path, "utf8"))?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return new Map();
    return new Map(Object.entries(files).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return new Map();
  }
}

// True when `dest` holds bytes the installer did not write: not the recorded hash, not the template.
export function userEdited(manifest: Manifest, rel: string, dest: string, template: Buffer): boolean {
  const recorded = manifest.get(rel);
  if (recorded === undefined || !existsSync(dest)) return false;
  const current = readFileSync(dest);
  if (current.equals(template)) return false;
  return createHash("sha256").update(current).digest("hex") !== recorded;
}
