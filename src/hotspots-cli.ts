import { successJson } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { rankHotspots, readChanges } from "./hotspots";

// `factory hotspots`: the files that the most recent merged PRs each changed.
export async function cmdHotspots(cli: CliContext): Promise<void> {
  const count = Number(cli.flag("commits") ?? 200);
  const top = Number(cli.flag("top") ?? 20);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(top) || top < 1)
    throw new Error("usage: factory hotspots [--commits <n>] [--top <n>] [--json]");
  const changes = readChanges(process.cwd(), count);
  const spots = rankHotspots(changes, 2, top);
  if (cli.has("json")) return void console.log(successJson({ prs: changes.length, hotspots: spots }));
  console.log(`${changes.length} merged PRs read; files changed by more than one:`);
  for (const h of spots) console.log(`${String(h.prs).padStart(4)}  ${h.file}${h.shared ? "  (listed shared)" : ""}`);
  if (!spots.length) console.log("none");
}
