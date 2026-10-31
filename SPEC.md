<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: #151
Epic: e2-reliability
Milestone: phase-1
Runner: factory

## Risk: medium

## Why
The factory keeps all its state in SQLite files under `FACTORY_HOME`: the run state, the board (`plane.db`), slot leases and spend (`machine.db`), and integration links (`integrations.db`). Nothing copies them anywhere, so one lost disk loses every run record and every lease. #120 built a verified snapshot to the object store, but it never merged, it covers only the run-state files, and nothing runs it on a schedule. #121 (the schedule and the restore) closed with no branch. This spec lands both as one change. A daily backup runs inside the stack and covers every state file. Each backup has a sha256 manifest, written last. `factory backup restore` checks every hash before it writes a byte, and it will not overwrite a file unless given `--force`.

## Today
- No `src/backup.ts` on main and no `backup` command; `factory backup` is an unknown command.
- Salvage: branch `factory/issue-120` adds `src/backup.ts` (158 lines), `tests/backup.test.ts` (9 tests), `tests/helpers/fake-s3.ts` (a fake S3 endpoint with DELETE and a `failDelete` hook) and a `tests/blobs.test.ts` hunk that moves its fake endpoint into that helper. Those four files are kept as they are. Against main, `quality-baseline.json` and `tests/mutations.json` conflict. `src/cli.ts` and `src/help.ts` merge, but the branch's inline `cmdBackup` in `src/cli.ts` reads module globals and grows the file, so it is dropped (T3 writes the command in its own file).
- On the branch, `backupSources(home)` returns the shared `factory.db` and each repo's `factory.db` only. `backupOnce` snapshots each one with `VACUUM INTO` and then `integrity_check`, uploads `backups/<id>/<name>`, and writes `manifest.json` (`{createdAt, files: [{key, bytes, sha256}]}`) last. `listBackups` returns only folders that have a manifest, newest first. `pruneBackups` deletes the manifest first.
- State paths on main: `src/machine.ts:38` (`<home>/machine.db`), `dashboard/server.ts:126` (`FACTORY_PLANE_DB`, else `<home>/plane.db`), `src/integrations/links.ts:20` (`<home>/integrations.db`).
- `src/deploy/stack.ts:82-91` `startStack` starts the blob mirror with `setInterval` and then `await plane()`. Nothing starts a backup.
- `src/cli.ts` is 976 lines, frozen at 976 in `quality-baseline.json:129`. `cmdReceipt` (`src/cli.ts:861-893`) reads the module globals `args`, `flag` and `has`, and is dispatched at `:958` as `return cmdReceipt();`. Other commands are dispatched lazily, for example `case "explain": return (await import("./explain-cli")).cmdExplain(cli);`, with `CliContext` (`src/cli-runtime.ts:17`: `args`, `flag`, `has`).
- `tests/help.test.ts:13` requires `COMMANDS` in `src/help.ts` to equal the `case` labels in `src/cli.ts`.

## Change
### T1: land the snapshot and widen it to every state file
Files: `src/backup.ts`, `tests/backup.test.ts`, `tests/helpers/fake-s3.ts`, `tests/blobs.test.ts`
Model: sonnet
1. `git fetch origin factory/issue-120 && git diff origin/main...origin/factory/issue-120 -- src/backup.ts tests/backup.test.ts tests/helpers/fake-s3.ts tests/blobs.test.ts | git apply -3`. Do not take that branch's `src/cli.ts`, `src/help.ts`, `quality-baseline.json` or `tests/mutations.json`. If the branch is gone, write the four files from the description under Today.
2. In `backupSources(home)`, after the run-state files, add each of `plane.db`, `machine.db` and `integrations.db` as `join(home, name)` when that file exists. Read the paths directly; do not import from `src/machine.ts` or `dashboard/`.
3. Add `at: string` to `BackupConfig`. `backupConfigFromEnv` reads `FACTORY_BACKUP_AT`, which defaults to `"03:30"`. When the value does not match `/^([01]\d|2[0-3]):[0-5]\d$/`, it throws `` `FACTORY_BACKUP_AT must be HH:MM (UTC), got ${value}` ``. Update both expected objects in the env test and `configFor` in the test file with `at: "03:30"`. Add a case where `FACTORY_BACKUP_AT: "25:00"` throws.
4. Add `const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");` and use it at the one place `backupOnce` hashes.
5. `tests/backup.test.ts` "backupSources finds..." also creates `plane.db`, `machine.db` and `integrations.db` in the home and expects them after the repo DBs. A home with none of them gives the old list.

### T2: restore with a sha check, and the daily schedule
Files: `src/backup.ts`, `src/deploy/stack.ts`, `tests/backup.test.ts`
Model: sonnet
Deps: T1
1. Export `restoreBackup(config: BackupConfig, opts: { id?: string; date?: string; to: string; force: boolean }): Promise<string[]>`. Pick the backup from `listBackups(config)`: by exact `id`, or else the newest whose id starts with `date` (`YYYY-MM-DD`). With no match, throw `` `no backup ${opts.id ?? opts.date} in the bucket` ``.
2. Read `backups/<id>/manifest.json`. For each file, its name is the key without `backups/<id>/`. Throw `` `${name}: unsafe path in the manifest` `` when the name is absolute or has a `..` segment.
3. Download every file first, and for each one run exactly: ``if (sha256Hex(bytes) !== f.sha256) throw new Error(`${name}: sha256 does not match the manifest`);``. Then, still before any write, check every target `join(opts.to, name)` with exactly: ``if (existsSync(target) && !force) throw new Error(`${target} exists; pass --force to overwrite`);``. Only then, for each file: create its folder, write `<target>.restore`, rename it onto `target`, and remove `<target>-wal` and `<target>-shm` with `{ force: true }`. Return the targets.
4. Export `nextRunAt(now: Date, at: string): Date`, the first UTC instant after `now` at `HH:MM`.
5. Export `scheduleBackups(config, home, log = console.error, timer = setTimeout, now = () => new Date()): () => void`. It arms `timer` for `nextRunAt(now(), config.at)`. When the timer fires, it runs `backupOnce(config, backupSources(home), home)` and then `pruneBackups(config)`. It logs `` `[backup] ${id}, ${n} file(s); pruned ${m}` `` on success or `` `[backup] failed: ${message}` `` on error, and arms the next run either way. It returns a function that clears the pending timer.
6. Export `startBackups(env = process.env, schedule = scheduleBackups)`. Its body is `const config = backupConfigFromEnv(env);` followed by exactly `return config ? schedule(config, factoryHome(env)) : undefined;`.
7. `src/deploy/stack.ts`: import `startBackups` from `../backup`, and call `startBackups(env);` after the blob mirror block, before `await plane();`.
8. Tests in `tests/backup.test.ts`, against `fakeS3`. First, back up a home with two DBs, restore into an empty dir, and check that the rows match. Second, restoring onto existing files without `force` throws `pass --force` and changes no file, and with `force` the files are replaced and a stale `-wal` file is gone. Third, after overwriting one object's bytes in `objects`, restore throws `sha256 does not match` and writes no file. Fourth, `date` picks the newest backup of that day. Fifth, an unknown id throws `no backup`. Sixth, a manifest with a `../x` name throws `unsafe path`. Then `nextRunAt` gives the same day before `at` and the next day after it. `scheduleBackups` with a fake timer runs one backup when fired, re-arms, and logs and re-arms when the run fails. `startBackups` with no bucket returns `undefined` and never calls `schedule`, and with a bucket calls it with the config and `FACTORY_HOME`. Finally, `src/deploy/stack.ts` contains `startBackups(env);` before `await plane();`.

### T3: the `backup` command, and a smaller `src/cli.ts`
Files: `src/backup-cli.ts`, `src/receipt-cli.ts`, `src/cli.ts`, `src/help.ts`, `quality-baseline.json`, `tests/backup.test.ts`
Model: sonnet
Deps: T2
1. Create `src/backup-cli.ts` exporting `cmdBackup(cli: CliContext)`, with `CliContext` from `./cli-runtime`. It handles `now` (backupOnce, then prune, print the id, the file count and the pruned count), `list` (one `<id>  <n> object(s)` line per backup, or `factory backup: no backups in the bucket.`), and `restore (--id <id> | --date <YYYY-MM-DD>) [--to <dir>] [--force]`. `--to` defaults to `factoryHome()`. `restore` prints one line per restored file and a closing line that says to start the stack again. `--json` prints `successJson(...)` for all three. With backups off it throws `backups are off: set FACTORY_BACKUP_BUCKET (or FACTORY_BLOB_BUCKET)`. Any other subcommand throws `UsageError` with the usage line.
2. Create `src/receipt-cli.ts` and move `cmdReceipt` and its two-line comment there from `src/cli.ts:861-893`, unchanged except that it takes `cli: CliContext` and reads `cli.args`, `cli.flag` and `cli.has`. Its imports come along: `./receipt`, `./cli-output`, and `node:fs`.
3. `src/cli.ts`: `case "receipt": return (await import("./receipt-cli")).cmdReceipt(cli);` and, right after it, `case "backup": return (await import("./backup-cli")).cmdBackup(cli);`. Delete the `./receipt` import and every other import that is now unused (`bunx biome check` and `bunx tsc --noEmit` stay clean).
4. `src/help.ts`: after `receipt`, add `{ name: "backup", usage: "backup (now | list | restore (--id <id> | --date <YYYY-MM-DD>) [--to <dir>] [--force]) [--json]", does: "now: snapshot every state DB to the bucket with a sha256 manifest, then prune past FACTORY_BACKUP_KEEP_DAYS; list: the backups there; restore: check every sha256, then write the files (stop the stack first)" }`.
5. In `quality-baseline.json`, set `lines["src/cli.ts"]` (976 today, at `:129`) to the file's new size from `wc -l src/cli.ts`, which must be below 976. Change no other value. `scripts/kaas/check-quality.py --update` does not help here, because it skips this baseline.
6. `tests/backup.test.ts`: run `bun bin/factory backup list` with no bucket env and expect exit 1 with `backups are off` on stderr.

### T4: the mutation files
Files: `tests/mutations/backup-the-snapshot-is-a-plain-copy-not-vacuum-into.json`, `tests/mutations/backup-prune-keeps-the-old-backups.json`, `tests/mutations/backup-restore-skips-the-sha-check.json`, `tests/mutations/backup-restore-overwrites-without-force.json`, `tests/mutations/backup-the-stack-never-schedules-a-backup.json`
Model: haiku
Deps: T2
1. Write each entry under Mutation to its own file in `tests/mutations/`, named by the entry's slug (the `shardPath` rule from #151), in the `shardText` format: two-space JSON, keys in the order name, file, find, replace, test, and a trailing newline. Do not edit `tests/mutations.json`.
2. Run `bun scripts/check-mutations.ts "<name>"` for each of the five names. Each must print `bites`.

## Tests
- `tests/backup.test.ts`: [permanent] the salvaged snapshot, manifest, list and prune tests; every state file is a source; a restore checks the sha256 of every file before it writes, refuses to overwrite without `--force`, clears stale WAL files and refuses unsafe names; the schedule runs once per day and survives a failed run; the stack starts it; the CLI says when backups are off.
- `tests/blobs.test.ts`: [permanent] existing; passes on the shared fake endpoint.
- `tests/help.test.ts`: [permanent] existing; `backup` is listed and dispatched.
- `tests/quality.test.ts`: [permanent] existing; `src/cli.ts` shrinks to its new baseline.

## Mutation
```json
{"name":"backup: the snapshot is a plain copy, not VACUUM INTO","file":"src/backup.ts","find":"src.run(\"VACUUM INTO ?\", [target]);","replace":"require(\"node:fs\").copyFileSync(source, target);","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: prune keeps the old backups","file":"src/backup.ts","find":"b.at.getTime() < cutoff","replace":"b.at.getTime() >= cutoff","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: restore skips the sha check","file":"src/backup.ts","find":"if (sha256Hex(bytes) !== f.sha256)","replace":"if (false)","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: restore overwrites without --force","file":"src/backup.ts","find":"if (existsSync(target) && !force)","replace":"if (false)","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: the stack never schedules a backup","file":"src/backup.ts","find":"return config ? schedule(config, factoryHome(env)) : undefined;","replace":"return undefined;","test":"tests/backup.test.ts"}
```
All five finds exist only after the change. The first two come from the #120 branch, and each matches once in its `src/backup.ts`.

## Acceptance
- AC-1: a backup snapshots every state file under `FACTORY_HOME` through `VACUUM INTO`, with the manifest last: checked by `make test FILES=tests/backup.test.ts` (T1)
- AC-2: a restore checks every file's sha256 against the manifest before it writes, and overwrites nothing without `--force`: checked by `make test FILES=tests/backup.test.ts` (T2)
- AC-3: the stack schedules one backup a day at `FACTORY_BACKUP_AT` and keeps going after a failed run: checked by `make test FILES=tests/backup.test.ts` (T2)
- AC-4: `factory backup` is in help and dispatched, and says when backups are off: checked by `make test FILES=tests/help.test.ts` (T3)
- AC-5: `src/cli.ts` shrinks and its baseline is its size: checked by `make test FILES=tests/quality.test.ts` (T3)
- AC-6: the blob tests still pass on the shared fake endpoint: checked by `make test FILES=tests/blobs.test.ts` (T1)

## Non-goals
- NG-1: no backup of a `FACTORY_PLANE_DB` path outside `FACTORY_HOME`, and no backup of blobs (the blob store is already in the bucket).
- NG-2: no automatic restore and no restore while the stack runs; the command says to stop the stack first.
- NG-3: no change to `src/machine.ts`, `src/watch.ts` or `dashboard/`.
- NG-4: do not touch `.github/workflows`, and do not edit `tests/mutations.json`; mutations go in `tests/mutations/` (#151).
- NG-5: one PR for this spec, whose body follows `.github/pull_request_template.md`. Every commit carries the `Signed-off-by:` line from `CONTRIBUTING.md`. No em dashes in code, comments, docs or the PR. Each new file stays at 400 lines or fewer, with comment runs of 3 lines at most, so it needs no line baseline. Touch nothing outside Files.

## Files
- `src/backup.ts` (new)
- `src/backup-cli.ts` (new)
- `src/receipt-cli.ts` (new)
- `tests/backup.test.ts` (new)
- `tests/helpers/fake-s3.ts` (new)
- `tests/mutations/backup-the-snapshot-is-a-plain-copy-not-vacuum-into.json` (new)
- `tests/mutations/backup-prune-keeps-the-old-backups.json` (new)
- `tests/mutations/backup-restore-skips-the-sha-check.json` (new)
- `tests/mutations/backup-restore-overwrites-without-force.json` (new)
- `tests/mutations/backup-the-stack-never-schedules-a-backup.json` (new)
- `tests/blobs.test.ts` (edit: uses the shared fake endpoint)
- `src/deploy/stack.ts` (edit: `startBackups(env)`)
- `src/cli.ts` (edit: `receipt` and `backup` dispatched lazily, `cmdReceipt` moved out)
- `src/help.ts` (edit: `backup` entry)
- `quality-baseline.json` (edit: `src/cli.ts` lowered to its size)
