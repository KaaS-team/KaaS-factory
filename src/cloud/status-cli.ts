// `factory cloud status`: every cloud reservation and session the runner holds for the repo.
import { successJson, UsageError } from "../cli-output";
import type { CliContext } from "../cli-runtime";
import { loadConfig } from "../config";
import { defaultStatePath } from "../paths";
import { FactoryState } from "../state";
import { type CloudLedgerJson, cloudLedger } from "./ledger";

export function statusLines(data: CloudLedgerJson): string[] {
  const rows = [
    ...Object.entries(data.reservations).map(
      ([issue, r]) =>
        `#${issue} reserved ${r.provider || "(released)"} attempt ${r.attempt}${r.usd === undefined ? "" : ` $${r.usd}`}`,
    ),
    ...Object.entries(data.sessions).map(([issue, s]) => `#${issue} ${s.status} ${s.provider} session ${s.id}`),
  ];
  return rows.length ? rows : ["no cloud reservations"];
}

export async function cmdCloud(cli: CliContext): Promise<void> {
  if (cli.args[1] !== "status") throw new UsageError("usage: factory cloud status [--json]");
  const config = await loadConfig(await cli.resolveCloneDir());
  const db = cli.flag("db") ?? process.env.FACTORY_DB_PATH ?? defaultStatePath(process.env, config.repo);
  const state = new FactoryState(db);
  try {
    const data = cloudLedger(state, config.repo).all();
    if (cli.has("json")) return void console.log(successJson(data, true));
    for (const line of statusLines(data)) console.log(line);
  } finally {
    state.close();
  }
}
