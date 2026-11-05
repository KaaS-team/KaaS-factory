// `factory tools [--repo-dir <path>] [--write] [--json]`: calls the mapped tracker's list and read
// against its configured server and says which mapped calls work. update runs only with --write.

import { resolve } from "node:path";
import { makeMappedTracker } from "./adapters/trackers/mapped-make";
import { probeMapped } from "./adapters/trackers/mapped";
import { EXIT, successJson, UsageError } from "./cli-output";
import { loadConfig } from "./config";

interface ToolsCli {
  flag(name: string): string | undefined;
  has(name: string): boolean;
}

export async function cmdTools(cli: ToolsCli): Promise<void> {
  const dir = resolve(cli.flag("repo-dir") ?? ".");
  const { tracker } = await loadConfig(dir);
  if (tracker.kind !== "mapped")
    throw new UsageError(`factory tools probes a mapped tracker; this repo's tracker.kind is "${tracker.kind}"`);
  const rows = await probeMapped(makeMappedTracker(tracker, dir), cli.has("write"));
  const failed = rows.some((r) => r.status === "failed");
  if (cli.has("json")) console.log(successJson({ mapping: tracker.mapping, calls: rows }, !failed));
  else {
    console.log(`factory tools: mapping "${tracker.mapping}"`);
    for (const r of rows) console.log(`  ${r.call.padEnd(7)}${r.status.padEnd(8)}${r.detail}`);
  }
  if (failed) process.exit(EXIT.checksFailed);
}
