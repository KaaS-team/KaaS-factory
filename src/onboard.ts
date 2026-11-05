// `factory onboard`: read the repo, write a starter .factory/config.json when none is filled in,
// and name what a person still has to supply. The report steps (src/onboard-json.ts) cover the rest.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHARTER_PATH } from "./context";
import { describeStack, initConfig, isFilledIn } from "./init";
import { repoFromRemoteUrl } from "./config";
import { detectStack, diskFiles } from "./stack";
import { templateDir } from "./template-root";

export interface OnboardScan {
  readonly detected: readonly string[];
  readonly wrote: readonly string[];
  readonly missing: readonly string[];
}

// A filled-in config is a person's and is never rewritten here; `factory init --force` does that.
export function scanForOnboard(dir: string, write: boolean): OnboardScan {
  const stack = detectStack(diskFiles(dir));
  const wrote: string[] = [];
  const missing: string[] = [];
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
  const repo = remote.exitCode === 0 ? repoFromRemoteUrl(remote.stdout.toString().trim()) : undefined;
  const target = join(dir, ".factory", "config.json");
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (!isFilledIn(current)) {
    if (write) {
      const example = JSON.parse(
        readFileSync(join(templateDir(), ".factory", "config.example.json"), "utf8"),
      ) as Record<string, unknown>;
      mkdirSync(join(dir, ".factory"), { recursive: true });
      writeFileSync(target, `${JSON.stringify(initConfig(example, stack, repo), null, 2)}\n`);
      wrote.push(".factory/config.json");
    } else missing.push(".factory/config.json (run without --dry-run to write a starter)");
  }
  if (!repo) missing.push('a github origin remote: set "repo" in .factory/config.json by hand');
  if (stack.gates.length === 0) missing.push("gates: none detected, add them to .factory/config.json");
  const charter = join(dir, CHARTER_PATH);
  if (!existsSync(charter) || readFileSync(charter, "utf8").includes("TODO"))
    missing.push(`${CHARTER_PATH}: risk tiers and protected paths`);
  return { detected: describeStack(stack), wrote, missing };
}

export function scanLines(scan: OnboardScan): string[] {
  return [
    ...scan.detected.map((l) => `  detected ${l}`),
    ...scan.wrote.map((l) => `  wrote ${l}`),
    ...scan.missing.map((l) => `  missing ${l}`),
  ];
}
