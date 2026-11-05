// scripts/kaas/ is copied from the shared kit and the next sync overwrites any local edit, so an edit made here is lost (#623).
// scripts/kaas-vendored.json records each file's hash at the last sync; this fails when a file differs, is new, or is gone.
//
//   bun scripts/check-kaas-vendored.ts           fail on drift from the recorded hashes
//   bun scripts/check-kaas-vendored.ts --write   record the current hashes: the sync runs this right after it copies the kit
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VENDORED_DIR = "scripts/kaas";
export const MANIFEST = "scripts/kaas-vendored.json";

export type Hashes = Record<string, string>;

export function hashDir(root: string): Hashes {
  const dir = join(root, VENDORED_DIR);
  const out: Hashes = {};
  for (const name of readdirSync(dir).sort())
    out[`${VENDORED_DIR}/${name}`] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  return out;
}

export function drift(recorded: Hashes, actual: Hashes): string[] {
  const files = [...new Set([...Object.keys(recorded), ...Object.keys(actual)])].sort();
  return files.flatMap((f) => {
    if (recorded[f] === undefined) return [`${f}: not in ${MANIFEST}; the kit sync records new files`];
    if (actual[f] === undefined) return [`${f}: recorded at the last sync but missing`];
    return recorded[f] === actual[f]
      ? []
      : [`${f}: differs from the last sync; edit the shared kit and sync, never this copy`];
  });
}

export const writeManifest = (root: string): void =>
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(hashDir(root), null, 2)}\n`);

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  if (process.argv.includes("--write")) {
    writeManifest(root);
    console.log(`check-kaas-vendored: recorded ${MANIFEST}`);
  } else {
    const bad = drift(JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Hashes, hashDir(root));
    for (const b of bad) console.error(`check-kaas-vendored: ${b}`);
    if (bad.length > 0) process.exit(1);
    console.log("check-kaas-vendored: ok");
  }
}
