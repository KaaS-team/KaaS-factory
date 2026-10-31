<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: e2-reliability
Milestone: phase-1
Runner: factory

## Risk: medium

## Why
PR #397 (branch feat/e2-g4) adds `src/backup.ts`, which snapshots the factory's SQLite state to a bucket and restores it. A security review of it found three gaps. First, `pick` falls back from `FACTORY_BACKUP_*` to `FACTORY_BLOB_*`, so the backup uses the same bucket and credentials the runners hold; a runner could read the state databases or overwrite a snapshot. Second, restore trusts the manifest in the bucket: `f.key` is not checked to start with the backup prefix and `name` is only checked for `..` and absolute paths, so a manifest written with runner credentials can restore any file name under the target directory. Third, the manifest is not authenticated, so the sha256 check only proves the bytes match a hash that sits in the same bucket.

## Today
- `src/backup.ts` on the branch: `pick(name)` reads `FACTORY_BACKUP_${name}` then `FACTORY_BLOB_${name}`; `restore` parses `manifest.json`, slices `prefix.length` off each key, checks `isAbsolute` and `..`, checks the sha256 and writes `join(opts.to, name)`.
- `tests/backup.test.ts` has 19 tests with a fake S3 in `tests/helpers/fake-s3.ts`.

## Change
### T1: dedicated backup credentials, restricted restore names
Files: `src/backup.ts`, `tests/backup.test.ts`
Model: sonnet
1. `git fetch origin feat/e2-g4 main && git checkout -B feat/e2-g4 origin/feat/e2-g4`. Remove the `FACTORY_BLOB_*` fallback: the backup reads only `FACTORY_BACKUP_BUCKET`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`. When any is unset the backup does nothing and says which variable is missing.
2. In restore, refuse a manifest whose `f.key` does not start with the run prefix. Accept only these names: `factory.db`, `plane.db`, `machine.db`, `integrations.db`, and `<owner>/<repo>/factory.db` where each segment matches `/^[A-Za-z0-9_.-]+$/` and is not `.` or `..`. After joining, check `resolve(target)` is inside `resolve(opts.to)`. Throw before writing anything.
3. Tests: no blob fallback (blob vars set, backup vars unset, nothing uploaded); a manifest key outside the prefix is refused; a name like `../x`, `/etc/x`, `a/b/c/factory.db` and `evil.sh` are refused; the five allowed shapes restore.

### T2: sign the manifest
Files: `src/backup.ts`, `tests/backup.test.ts`
Model: sonnet
Deps: T1
1. When `FACTORY_BACKUP_SIGNING_KEY` is set, write `manifest.sig` next to the manifest: an HMAC-SHA256 hex of the exact manifest bytes (`node:crypto`, no new dependency). The signing key is never uploaded.
2. Restore verifies the signature with a constant-time compare before it reads any file, and refuses when the key is unset, the sig file is missing, or it does not match.
3. Tests: a signed snapshot restores; a manifest edited after signing is refused; a missing sig is refused; a wrong key is refused.

## Tests
- `tests/backup.test.ts`: [permanent] the cases in T1 and T2.

## Mutation
One shard file per rule under `tests/mutations/` (name `backup-<slug>.json`). Do not edit `tests/mutations.json`; `tests/mutation-list.test.ts` already counts shard files. Adjust each `find` to text that occurs exactly once in `src/backup.ts` as you wrote it, and confirm the replacement makes `tests/backup.test.ts` fail.
```json
{"name":"backup: restore accepts a key outside the prefix","file":"src/backup.ts","find":"startsWith(prefix)","replace":"startsWith(\"\")","test":"tests/backup.test.ts"}
```
Add the same shape for the allowed-name check and the signature compare.

## Acceptance
- AC-1: blob credentials are never used for backups: checked by `make test FILES=tests/backup.test.ts` (T1)
- AC-2: restore refuses a key outside the prefix and any name outside the allowed shapes: checked by `make test FILES=tests/backup.test.ts` (T1)
- AC-3: restore refuses an unsigned or altered manifest: checked by `make test FILES=tests/backup.test.ts` (T2)

## Non-goals
Do not touch .github/workflows. No new dependencies. No encryption of snapshots in this change. No em dashes, no filler words. Nothing outside Files and the new mutation shards.

## Files
- `src/backup.ts`
- `tests/backup.test.ts`
- `tests/mutations/backup-*.json`

## How to ship
Fast-forward commit on top of feat/e2-g4 so PR #397 updates, no force push. Commits use `git commit -s` with the trailer Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>. Run `bunx biome format --write` on every file you touched and `python3.12 scripts/kaas/check-affected.py --run` before pushing (tests/lean-resources.test.ts may fail in the sandbox only). Never put a session link in a commit.
