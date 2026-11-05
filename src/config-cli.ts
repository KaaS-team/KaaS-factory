// `factory config explain <key>`: which level (builtin, org, team or repo) set one config value.
import { UsageError } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { loadConfigExplained } from "./config";
import { explainKey } from "./team/explain";

const USAGE =
  "config: usage: factory config explain <key> (--repo-dir <path> | --repo <owner/name>) [--team <name>] [--label <l>]... [--path <p>]...";

export async function cmdConfig(cli: CliContext): Promise<void> {
  const key = cli.args[2];
  if (cli.args[1] !== "explain" || !key) throw new UsageError(USAGE);
  const labels = cli.flag("label")?.split(",").filter(Boolean) ?? [];
  const paths = cli.flag("path")?.split(",").filter(Boolean) ?? [];
  const applied = await loadConfigExplained(await cli.resolveCloneDir(), {
    team: cli.flag("team"),
    issue: labels.length || paths.length ? { labels, paths } : undefined,
  });
  console.log(`team ${applied.team ?? "none"}`);
  for (const line of explainKey(key, applied.resolved, applied.locked)) console.log(line);
}
