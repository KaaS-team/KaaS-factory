<!-- factory:planned v1 -->
Deps: none
Shared-ok: quality-baseline.json: the src/cli.ts cap is ratcheted down by this change, via scripts/gen-quality-baseline.ts
Epic: e1-reliability
Milestone: phase-1
Runner: factory

## Why
Every run's history, the plane's members and sessions, the machine's leases and spend, and the tracker links live in SQLite files under `FACTORY_HOME` on one disk, and nothing copies them anywhere: a lost box loses every run record and every plane login. Separately, slots are a machine-wide pool with no per-repo share, so one busy repo can take every slot and starve the others on the same machine (#69). This epic adds a nightly, verified SQLite backup to the existing blob bucket with list and restore commands (spec G4, both halves), and a per-repo lease cap inside the machine's slots (spec M1).

## Today
- `src/blobs.ts:23` `blobStoreFromEnv` builds an `S3BlobStore` from `FACTORY_BLOB_BUCKET`, `FACTORY_BLOB_ENDPOINT`, `FACTORY_BLOB_ACCESS_KEY_ID`, `FACTORY_BLOB_SECRET_ACCESS_KEY` and `FACTORY_BLOB_REGION`, or a `DiskBlobStore` from `FACTORY_BLOB_DIR`; nothing reads a `FACTORY_BACKUP_*` key.
- `src/ports/blob.ts:9` `BlobStore` has `put`, `get` and `list` only; there is no delete, so nothing can prune.
- `src/adapters/blob-s3/blob.ts:5` and `src/adapters/blob-disk/blob.ts:6` are the only two implementations; `tests/blobs.test.ts:236`, `:359` and `:436` build object-literal fakes of the port.
- `tests/blobs.test.ts:69` holds a private `fakeS3()` that answers PUT, GET, HEAD and ListObjectsV2 but not DELETE.
- The databases: `dashboard/server.ts:126` opens `FACTORY_PLANE_DB` or `FACTORY_HOME/plane.db`; `src/machine.ts:37` `machine.db`; `src/integrations/links.ts:20` `integrations.db`; `src/paths.ts:42` `defaultStatePath(env, repo)` gives `FACTORY_HOME/<owner>/<name>/factory.db`; `src/paths.ts:57` `discoverRepos` lists every repo with a `factory.db`.
- `src/deploy/stack.ts:58` `startStack` runs the plane, relay and blob mirror for `factory up` with no repo; it schedules nothing else.
- `src/machine.ts:216` `MachineLeases.acquire(holder, slots, pid)` counts every lease on the machine; `src/machine.ts:262` `effectiveSlots` is `Math.min(repoConcurrency, machine.slots)`.
- `src/watch.ts:29` imports `effectiveSlots`; `src/watch.ts:594` `dispatchConcurrency` uses it; `src/watch.ts:602` acquires with holder `${config.repo}#${issue.number}` and that min as the slot count, so one repo with `concurrency` 3 on a 3-slot machine holds every slot.
- Callers of `acquire`: `src/watch.ts:602`, `tests/machine.test.ts:21`, `:31`, `:32`, `:42`, `:44`, `:65`, `tests/fleet.test.ts:54`, `:100`.
- `src/cli.ts` is 1084 lines, its cap in `quality-baseline.json`; `cmdReceipt` is `src/cli.ts:975` to `:1006` and its case is in `main()` at `src/cli.ts:1008`.
- `src/help.ts:4` `COMMANDS` lists every command; `tests/help.test.ts` diffs it against the `main()` switch.

## Change
### T1: Snapshot every database to the bucket with a hashed manifest
Files: `src/backup.ts`, `src/ports/blob.ts`, `src/adapters/blob-s3/blob.ts`, `src/adapters/blob-disk/blob.ts`, `tests/helpers/fake-s3.ts`, `tests/blobs.test.ts`, `tests/backup.test.ts`
Model: sonnet
1. In `src/ports/blob.ts` add an optional `delete?(key: string): Promise<void>` to `BlobStore`. Implement it in `S3BlobStore` as `await this.client.delete(this.checked(key))` and in `DiskBlobStore` as `rm(this.path(key), { force: true })`.
2. Move `fakeS3()` from `tests/blobs.test.ts:69` to `tests/helpers/fake-s3.ts` as an export, add a `DELETE` branch that removes the key and answers 204, and import it back in `tests/blobs.test.ts`.
3. Create `src/backup.ts`. Export `interface BackupConfig { store: BlobStore; at: string; keepDays: number }` and `backupConfigFromEnv(env)`: each `FACTORY_BACKUP_BUCKET`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` falls back to its `FACTORY_BLOB_*` twin; a `FACTORY_BACKUP_DIR` falls back to `FACTORY_BLOB_DIR`; build the store with the same rules as `blobStoreFromEnv`. No bucket and no dir returns undefined (backup off). `at` is `FACTORY_BACKUP_AT` or `03:30` and must match `/^([01]\d|2[0-3]):[0-5]\d$/`; `keepDays` is `FACTORY_BACKUP_KEEP_DAYS` or 14 and must be a positive integer; a bad value throws naming the key.
4. Export `backupSources(env): { name: string; path: string }[]`: `plane.db` (from `FACTORY_PLANE_DB` or `FACTORY_HOME/plane.db`), `machine.db`, `integrations.db`, and `<owner>/<name>/factory.db` for each `discoverRepos(env)`; only files that exist. `name` is the path relative to `FACTORY_HOME`, so a restore into `FACTORY_HOME` puts each file back where it was read (a plane db outside `FACTORY_HOME` restores as `plane.db`).
5. Export `backupOnce(cfg, env, now = new Date())`. For each source: open it read-only with `bun:sqlite`, write the snapshot to a temp dir with this exact line `` db.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`); ``, open the snapshot and require `PRAGMA integrity_check` to return `ok` (else throw naming the source), hash it with `sha256` from `src/engine/import-plan.ts`, and `put` it at `backups/<YYYY-MM-DD>/<name>`. Write `backups/<date>/manifest.json` last, as `{ v: 1, at: now.toISOString(), files: [{ name, sha256, bytes }] }`. Remove the temp dir in a `finally`. Return the manifest.
6. Export `listBackups(cfg)`: the dates that have a `manifest.json`, newest first. Export `pruneBackups(cfg, now)`: delete every key under a date older than `keepDays` days, using `cfg.store.delete`; do nothing when the store has no `delete`. A date within `keepDays` is kept with this exact line: `if (ageDays(date, now) <= cfg.keepDays) continue;`

### T2: Restore with a hash check, and a nightly scheduler on the stack
Files: `src/backup.ts`, `src/deploy/stack.ts`, `tests/backup.test.ts`
Model: sonnet
1. Export `restoreBackup(cfg, { date, to, force })` from `src/backup.ts`. Read `backups/<date>/manifest.json` (missing: throw `no backup for <date>`). First get every file's bytes and compare hashes with this exact line `` if (sha256(bytes) !== f.sha256) throw new Error(`${f.name}: sha256 does not match the manifest`); `` before anything is written. The target path is `join(to, f.name)`; when it exists and `force` is false throw `<path> exists; pass --force to overwrite`. Write to `<path>.restore` then rename over the target, and delete a stale `<path>-wal` and `<path>-shm`. Return the restored paths.
2. Export `nextRunAt(now: Date, at: string): Date`: today at `at` UTC when that is still ahead of `now`, else tomorrow at `at`.
3. Export `scheduleBackups(cfg, env, log = console.error): () => void`: a `setTimeout` to `nextRunAt`, which runs `backupOnce` then `pruneBackups`, logs a failure as `[backup] <message>` and reschedules either way; returns a stop function.
4. In `src/deploy/stack.ts` `startStack`, after the mirror block, call `backupConfigFromEnv(env)` and, when it is defined, `scheduleBackups(cfg, env)` and log `factory up: nightly backup at <at> UTC, kept <keepDays> days`.

### T3: The backup command, with room made in the CLI
Files: `src/backup-cli.ts`, `src/receipt-cli.ts`, `src/cli.ts`, `src/help.ts`, `quality-baseline.json`, `tests/backup.test.ts`
Model: sonnet
Deps: T1 T2
1. Create `src/backup-cli.ts` exporting `cmdBackup(cli: CliContext)` (the `CliContext` from `src/cli-runtime.ts`). `factory backup now` runs `backupOnce` then `pruneBackups` and prints one line per file; `list` prints the dates; `restore --date <YYYY-MM-DD> [--to <dir>] [--force]` calls `restoreBackup` with `to` defaulting to `factoryHome()`; `--json` prints `successJson`. With backup off, exit `EXIT.error` with `factory backup: set FACTORY_BACKUP_BUCKET or FACTORY_BLOB_BUCKET`.
2. Move `cmdReceipt` (`src/cli.ts:975` to `:1006`) unchanged into new `src/receipt-cli.ts` as `cmdReceipt(cli: CliContext)`, reading `cli.args`, `cli.flag`, `cli.has` in place of the module globals, and drop the `src/cli.ts` imports only it used.
3. In `main()` dispatch `case "receipt": return (await import("./receipt-cli")).cmdReceipt(cli);` and `case "backup": return (await import("./backup-cli")).cmdBackup(cli);`.
4. Add a `backup` entry to `COMMANDS` in `src/help.ts`: usage `backup (now | list | restore --date <YYYY-MM-DD> [--to <dir>] [--force]) [--json]`.
5. Set `lines["src/cli.ts"]` in `quality-baseline.json` to the new `wc -l`; it must be below 1084.

### T4: A per-repo lease cap inside the machine's slots
Files: `src/machine.ts`, `src/watch.ts`, `tests/machine.test.ts`, `tests/fleet.test.ts`
Model: sonnet
1. In `src/machine.ts` export `interface LeaseCaps { repo: string; repoCap: number; machineSlots: number }` and change `acquire` to `acquire(holder: string, caps: LeaseCaps, pid = process.pid)`.
2. Inside the existing `BEGIN IMMEDIATE` transaction, after the machine count, count this repo's live leases with `holder LIKE $prefix ESCAPE '\\'`, where `$prefix` is `escapeLike(caps.repo) + "#%"` and `escapeLike` (a new local function) escapes `\`, `%` and `_`. Return undefined when the repo is full, written as exactly: `if (mine >= caps.repoCap) return undefined;`
3. Delete `effectiveSlots` and export `leaseCaps(config: { repo: string; concurrency: number }, machine: MachineConfig): LeaseCaps` returning `{ repo: config.repo, repoCap: config.concurrency, machineSlots: machine.slots }`.
4. In `src/watch.ts`, swap `effectiveSlots` for `leaseCaps` in the import at `:29`; make `dispatchConcurrency` at `:594` return `deps.machine ? Math.min(config.concurrency, deps.machine.config.slots) : config.concurrency`; at `:602` pass `leaseCaps(config, deps.machine.config)` as the second argument. `src/watch.ts` must stay at or under 849 lines.
5. Update every `acquire` call in `tests/machine.test.ts` and `tests/fleet.test.ts` to the object form, and replace the `effectiveSlots` describe in `tests/machine.test.ts:89` with the repo-cap tests below.

## Tests
- `tests/backup.test.ts`: [permanent] `backupOnce` over a temp `FACTORY_HOME` with a plane, machine and one repo db writes each file plus `manifest.json` last, and each manifest sha256 equals the hash of the stored bytes.
- `tests/backup.test.ts`: [permanent] a row written in WAL mode with `wal_autocheckpoint=0` and the writer still open is present in the snapshot.
- `tests/backup.test.ts`: [permanent] `restoreBackup` refuses an existing target without `force`, overwrites it with `force` and removes a stale `-wal` and `-shm`; a tampered stored file throws `sha256 does not match` and writes nothing.
- `tests/backup.test.ts`: [permanent] `pruneBackups` with `keepDays` 14 deletes a 15-day-old date and keeps a 14-day-old one, against the fake S3 from `tests/helpers/fake-s3.ts`.
- `tests/backup.test.ts`: [permanent] `nextRunAt` at 03:00 UTC gives 03:30 the same day and at 04:00 gives 03:30 the next day; `backupConfigFromEnv` falls back to `FACTORY_BLOB_BUCKET`, is undefined with neither, and throws on `FACTORY_BACKUP_AT=25:00`.
- `tests/machine.test.ts`: [permanent] two repos sharing 4 machine slots with `repoCap` 2: the third lease for `a/x` returns undefined while `b/y` still gets one; a repo named `a_x` is not counted as `abx`.
- `tests/fleet.test.ts` and `tests/blobs.test.ts`: [permanent] existing suites stay green on the new signature and the shared fake S3.

## Mutation
```json
{"name":"backup: copy the file instead of VACUUM INTO","file":"src/backup.ts","find":"db.exec(`VACUUM INTO '${snap.replaceAll(\"'\", \"''\")}'`);","replace":"await Bun.write(snap, Bun.file(src.path));","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: restore skips the sha check","file":"src/backup.ts","find":"if (sha256(bytes) !== f.sha256) throw new Error(`${f.name}: sha256 does not match the manifest`);","replace":"","test":"tests/backup.test.ts"}
```
```json
{"name":"backup: prune deletes everything","file":"src/backup.ts","find":"if (ageDays(date, now) <= cfg.keepDays) continue;","replace":"","test":"tests/backup.test.ts"}
```
```json
{"name":"leases: no per-repo cap","file":"src/machine.ts","find":"if (mine >= caps.repoCap) return undefined;","replace":"","test":"tests/machine.test.ts"}
```

Save each entry above as its own file, one JSON object each: `tests/mutations/backup-copy-the-file-instead-of-vacuum-into.json`, `tests/mutations/backup-restore-skips-the-sha-check.json`, `tests/mutations/backup-prune-deletes-everything.json`, `tests/mutations/leases-no-per-repo-cap.json`. Never edit tests/mutations.json. Adjust a `find` that no longer matches exactly once.

## Acceptance
- AC-1: every database is snapshotted with VACUUM INTO, integrity-checked and stored with a sha256 manifest written last: checked by `make test FILES="tests/backup.test.ts tests/blobs.test.ts"` (T1)
- AC-2: restore checks every hash before writing, refuses to overwrite without force and drops stale WAL files; the scheduler fires at the configured UTC time: checked by `make test FILES=tests/backup.test.ts` (T2)
- AC-3: `factory backup now|list|restore` is dispatched and documented, and `src/cli.ts` shrinks: checked by `make test FILES=tests/help.test.ts` (T3)
- AC-4: one repo never holds more than its cap of the machine's slots: checked by `make test FILES="tests/machine.test.ts tests/fleet.test.ts"` (T4)
- AC-5: the four checks bite and the gate is clean: checked by `make check`, `make check-mutations` (T4)

## Non-goals
- NG-1: no backup of the pool usage db, run directories or transcripts; the blob mirror already ships run files.
- NG-2: no scheduler inside a per-repo `factory watch`; only the stack (`factory up` with no repo) schedules.
- NG-3: no change to how `concurrency` is validated in `src/config.ts` (at its line cap).
- NG-4: no encryption at rest beyond the bucket's own; no restore into a running process.

## Files
- `src/backup.ts` (new)
- `src/backup-cli.ts` (new)
- `src/receipt-cli.ts` (new)
- `tests/backup.test.ts` (new)
- `tests/helpers/fake-s3.ts` (new)
- `src/ports/blob.ts`
- `src/adapters/blob-s3/blob.ts`
- `src/adapters/blob-disk/blob.ts`
- `src/deploy/stack.ts`
- `src/cli.ts`
- `src/help.ts`
- `src/machine.ts`
- `src/watch.ts`
- `quality-baseline.json`
- `tests/mutations/backup-copy-the-file-instead-of-vacuum-into.json` (new)
- `tests/mutations/backup-restore-skips-the-sha-check.json` (new)
- `tests/mutations/backup-prune-deletes-everything.json` (new)
- `tests/mutations/leases-no-per-repo-cap.json` (new)
- `tests/blobs.test.ts`
- `tests/machine.test.ts`
- `tests/fleet.test.ts`

## Risk: medium
Restore overwrites live databases, so it refuses without `--force` and checks every hash before the first write. The lease change touches the dispatch path every watcher uses; the per-repo cap equals today's per-process `concurrency`, so a single-repo machine behaves the same, which `tests/fleet.test.ts` pins. Rollback: revert the PR; backups already written stay readable by hand.

## Model: sonnet

