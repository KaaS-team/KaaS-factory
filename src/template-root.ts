// Where the runner's template/ and template-ci/ live. From source that is the repo; in a compiled
// binary the files are embedded at build time and written once under the factory home.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { factoryHome } from "./paths";

declare const FACTORY_EMBEDDED_TEMPLATE: Record<string, string> | undefined;

export function embeddedTemplate(): Record<string, string> | undefined {
  return typeof FACTORY_EMBEDDED_TEMPLATE === "undefined" ? undefined : FACTORY_EMBEDDED_TEMPLATE;
}

let cached: string | undefined;

export function runnerRoot(files = embeddedTemplate(), env: NodeJS.ProcessEnv = process.env): string {
  if (!files) return resolve(import.meta.dir, "..");
  if (cached) return cached;
  const id = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  const target = join(factoryHome(env), "runner", id);
  if (!existsSync(join(target, ".complete"))) {
    const tmp = `${target}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(files)) {
      const dest = join(tmp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(b64, "base64"));
    }
    writeFileSync(join(tmp, ".complete"), "");
    try {
      renameSync(tmp, target);
    } catch (err) {
      if (!existsSync(join(target, ".complete"))) throw err;
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  cached = target;
  return target;
}

export const templateDir = (): string => join(runnerRoot(), "template");

// The skills this runner ships, keyed by their path in a target repo.
export function templateSkills(): Record<string, string> {
  const root = templateDir();
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(join(root, ".claude", "skills"));
  return out;
}
