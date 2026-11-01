// `factory backup`: snapshot every state DB to the bucket, list the backups there, or restore one.
import { backupConfigFromEnv, backupOnce, backupSources, listBackups, pruneBackups, restoreBackup } from "./backup";
import { successJson, UsageError } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { factoryHome } from "./paths";

const USAGE =
  "usage: factory backup (now | list | restore (--id <id> | --date <YYYY-MM-DD>) [--to <dir>] [--force]) [--json]";

export async function cmdBackup(cli: CliContext): Promise<void> {
  const config = backupConfigFromEnv();
  if (!config) throw new Error("backups are off: set FACTORY_BACKUP_BUCKET (or FACTORY_BLOB_BUCKET)");
  const sub = cli.args[1];
  const json = cli.has("json");
  if (sub === "now") {
    const home = factoryHome();
    const { id, files } = await backupOnce(config, backupSources(home), home);
    const pruned = await pruneBackups(config);
    if (json) return void console.log(successJson({ id, files: files.length, pruned }));
    return void console.log(`factory backup: ${id}, ${files.length} file(s); pruned ${pruned.length}`);
  }
  if (sub === "list") {
    const backups = await listBackups(config);
    if (json)
      return void console.log(successJson({ backups: backups.map((b) => ({ id: b.id, objects: b.keys.length })) }));
    if (!backups.length) return void console.log("factory backup: no backups in the bucket.");
    for (const b of backups) console.log(`${b.id}  ${b.keys.length} object(s)`);
    return;
  }
  const id = cli.flag("id");
  const date = cli.flag("date");
  if (sub === "restore" && (id || date)) {
    const to = cli.flag("to") ?? factoryHome();
    const written = await restoreBackup(config, { id, date, to, force: cli.has("force") });
    if (json) return void console.log(successJson({ to, files: written }));
    for (const f of written) console.log(`restored ${f}`);
    return void console.log("factory backup: restore done; start the stack again.");
  }
  throw new UsageError(USAGE);
}
