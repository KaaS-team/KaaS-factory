#!/usr/bin/env node
// Runs the binary the postinstall step placed next to this file.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "factory-bin");
if (!existsSync(bin)) {
  console.error("factory: the binary is missing, run `npm rebuild @kaas-team/factory`");
  process.exit(1);
}
process.exit(spawnSync(bin, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
