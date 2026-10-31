<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
Parallel branches break each other when they edit a file every branch touches, or when a test pins the size of a registry that branches grow. Two cloud sessions stalled on a hard-coded shard count in one test, and every merge hit the same append-only files. The registries are now per-feature files (mutation shards, `make/*.mk`, `tests/ci-wiring/*.json`). Nothing yet stops a new spec from naming the old shared files, or a new test from pinning a registry size. Issue #402.

## Today
- `parsePlannedIssue` in `src/engine/import-plan.ts` reports problems for a plan (it already checks that every task file is in `## Files`). `scripts/lint-planned.ts` calls it, so any problem it returns fails the lint. Read both first.
- The shard folders on main are `tests/mutations/`, `tests/ci-wiring/` and `make/`. The loader tests derive counts (`legacy.length + shards`), so no test pins one today.

## Change
### T1: the shared-file list and the spec check
Files: `src/shared-files.ts`, `src/engine/import-plan.ts`, `tests/shared-files.test.ts`
Model: sonnet
1. `src/shared-files.ts` exports `SHARED_FILES: readonly string[]` = `tests/mutations.json`, `tests/ci-wiring.test.ts`, `tests/mutation-list.test.ts`, `tests/skip-count.test.ts`, `quality-baseline.json`, `Makefile`. It exports `sharedClaims(files: string[], okLines: string[]): string[]` returning the shared paths in `files` that no `okLines` entry excuses. An ok line has the form `Shared-ok: <path>: <reason>` with a non-empty reason.
2. In `parsePlannedIssue`, after the Files checks, push one problem per unexcused shared path: `names shared file \`<path>\`; add a shard or a make/*.mk file instead, or excuse it with "Shared-ok: <path>: <reason>".` Read the header lines the same way the `Files:` line is read.
3. Tests: a plan whose task lists `tests/mutations.json` fails with that message; the same plan with `Shared-ok: tests/mutations.json: migration` passes; an ok line with no reason does not excuse; a plan listing only a shard file passes; every path in `SHARED_FILES` exists in the repo or is documented as retired in the test.

### T2: the structural test against pinned counts
Files: `tests/no-pinned-counts.test.ts`
Model: sonnet
Deps: T1
1. Walk `tests/*.test.ts`. For each file that mentions `tests/mutations`, `tests/ci-wiring` or `make/`, or calls `loadMutations`, fail when a line within 3 lines of that mention matches `.length).toBe(<digits>)`, `toHaveLength(<digits>)` or `.size).toBe(<digits>)`.
2. A file may opt out with a line `// count-ok: <reason>` above the assertion; the test lists the opt-outs it found so review sees them.
3. Test the scanner itself on strings: a pinned count is caught, a derived one (`toBe(legacy.length + shards)`) is not, an opt-out is honoured.

## Tests
- `tests/shared-files.test.ts`: [permanent] the spec check cases.
- `tests/no-pinned-counts.test.ts`: [permanent] the scanner cases and the walk over the real tests.

## Mutation
```json
{"name":"shared files: an excuse without a reason passes","file":"src/shared-files.ts","find":"reason.trim()","replace":"true","test":"tests/shared-files.test.ts"}
```
Adjust `find` to text that occurs exactly once in your file, and make sure the test goes red under it. Save it to `tests/mutations/shared-files-an-excuse-without-a-reason-passes.json` (a single JSON object).

## Acceptance
- AC-1: a spec naming a shared file is rejected unless excused with a reason: checked by `make test FILES=tests/shared-files.test.ts` (T1)
- AC-2: a spec naming only shard files passes: checked by `make test FILES=tests/shared-files.test.ts` (T1)
- AC-3: a test that pins the size of a sharded registry fails the suite: checked by `make test FILES=tests/no-pinned-counts.test.ts` (T2)
- AC-4: a derived count and an opt-out with a reason pass: checked by `make test FILES=tests/no-pinned-counts.test.ts` (T2)

## Non-goals
Do not edit the shared files themselves. Do not touch `.github/workflows`. No new dependencies. No em dashes, no filler words. Nothing outside Files. The cloud launch prompt text lives outside this repo and is not part of this change.

## Files
- `src/shared-files.ts`
- `src/engine/import-plan.ts`
- `tests/shared-files.test.ts`
- `tests/no-pinned-counts.test.ts`
- `tests/mutations/shared-files-an-excuse-without-a-reason-passes.json`

## How to ship
One PR from branch feat/b5-count-guard, with `Closes #402`. Commits use `git commit -s`. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing, and run the new tests with `make test FILES='tests/shared-files.test.ts tests/no-pinned-counts.test.ts' TEST_ARGS='--rerun-each 3'`. The mutation goes in the shard file named above, never in tests/mutations.json. Never put a session link in a commit or PR.
