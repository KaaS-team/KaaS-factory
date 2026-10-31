<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: #151
Epic: e2-reliability
Milestone: phase-1
Runner: factory

## Risk: low

## Why
Watchers for several repos share one machine's slots through `machine.db` leases. Today a repo's own `concurrency` is folded into the machine count: a lease is granted when the leases of every repo together are below `min(repo concurrency, machine slots)`. So a repo with `concurrency: 1` waits whenever any other repo holds a slot, while a repo with a high cap can take every slot. Each repo should be capped by its own count and the machine by the total. #123 made that change on a branch, with a test and a mutation, and it never merged. This spec lands it on current main. Closes #69.

## Today
- `src/machine.ts` `MachineLeases.acquire(holder, slots, pid)` counts every lease in `machine.db` and refuses when the count reaches `slots`. `effectiveSlots(repoConcurrency, machine)` at `:262` returns `Math.min(repoConcurrency, machine.slots)`.
- `src/watch.ts:593-595` `dispatchConcurrency` uses `effectiveSlots`, and `:601` passes it as `slots` to `acquire`. The holder is `` `${config.repo}#${issue.number}` ``.
- Callers of `acquire` with a number: `tests/machine.test.ts:21,31,32,42,44,65` and `tests/fleet.test.ts:54,100`. `tests/machine.test.ts:89-93` tests `effectiveSlots`.
- Salvage: branch `factory/issue-123` changes `src/machine.ts`, `src/watch.ts`, `tests/machine.test.ts`, `tests/fleet.test.ts` and `tests/mutations.json`. Against main, only `tests/mutations.json` conflicts, and `src/watch.ts` merges. Applied onto main, the four code and test files pass `tests/machine.test.ts`, `tests/fleet.test.ts`, `tests/machine-dispatch.test.ts`, `tests/multi-repo.test.ts` and `tests/spend-caps.test.ts` (47 pass). `bunx tsc --noEmit` is clean. `src/machine.ts` goes from 309 to 320 lines, which is under 400, so it has no line baseline. `src/watch.ts` stays at 848, its baseline. With the repo count removed, 2 tests in `tests/machine.test.ts` fail.

## Change
### T1: per-repo count inside the machine count
Files: `src/machine.ts`, `src/watch.ts`, `tests/machine.test.ts`, `tests/fleet.test.ts`
Model: haiku
1. `git fetch origin factory/issue-123 && git diff origin/main...origin/factory/issue-123 -- src/machine.ts src/watch.ts tests/machine.test.ts tests/fleet.test.ts | git apply -3`. Do not check out whole files from the branch, because main changed `src/watch.ts` after the branch point. Do not take its `tests/mutations.json`.
2. Check the result against this list, and write any missing piece by hand.
   - `src/machine.ts` exports `interface LeaseCap { readonly repo: string; readonly repoCap: number; readonly machineSlots: number }` and `escapeLike(s)`, which returns `s.replace(/[\\%_]/g, "\\$&")`.
   - `acquire(holder: string, cap: LeaseCap, pid = process.pid)` refuses when the machine count reaches `cap.machineSlots`. It then counts this repo's leases with `SELECT COUNT(*) AS n FROM leases WHERE holder LIKE $prefix ESCAPE '\'`, where `$prefix` is `` `${escapeLike(cap.repo)}#%` ``, and refuses with exactly `if (mine >= cap.repoCap) return undefined;`. Both counts run inside the existing transaction.
   - `effectiveSlots` is deleted.
   - `src/watch.ts` imports `{ canServe, machineBeat }`. `dispatchConcurrency` returns `Math.min(config.concurrency, deps.machine.config.slots)` when a machine is configured. `dispatch` passes `{ repo: config.repo, repoCap: config.concurrency, machineSlots: deps.machine.config.slots }`.
3. Tests, kept from the branch. Every `acquire` call in `tests/machine.test.ts` and `tests/fleet.test.ts` passes a `LeaseCap`. The `effectiveSlots` describe becomes "per-repo cap", which has two tests. In the first, two repos share 4 slots with `repoCap` 2: a third lease for one repo waits while the other repo still gets a slot, and it is granted after a release. The second checks that `escapeLike` escapes `\`, `%` and `_`, and that a repo named `acme/a_b` is not counted with `acme/aXb`, nor `acme/a%` with `acme/ab`.
4. `wc -l src/watch.ts` must still print 848, the value at `quality-baseline.json:137`. The branch hunk is net zero lines, so make the `dispatch` comment one line, as the branch does, rather than editing the baseline.

### T2: the mutation file
Files: `tests/mutations/machine-acquire-drops-the-per-repo-count.json`
Model: haiku
Deps: T1
1. Write the entry under Mutation to `tests/mutations/machine-acquire-drops-the-per-repo-count.json`, as two-space JSON with keys in the order name, file, find, replace, test, and a trailing newline. This is the per-entry format from #151. Do not edit `tests/mutations.json`.
2. `bun scripts/check-mutations.ts "machine: acquire drops the per-repo count"` prints `bites`.

## Tests
- `tests/machine.test.ts`: [permanent] a repo at its cap waits while another repo gets a machine slot; LIKE wildcards in a repo name do not merge two repos' counts; the existing slot, reclaim and race tests pass with a `LeaseCap`.
- `tests/fleet.test.ts`: [permanent] existing; passes with a `LeaseCap`.
- `tests/machine-dispatch.test.ts`, `tests/multi-repo.test.ts`, `tests/spend-caps.test.ts`: [permanent] existing; unchanged.

## Mutation
```json
{"name":"machine: acquire drops the per-repo count","file":"src/machine.ts","find":"if (mine >= cap.repoCap) return undefined;","replace":"","test":"tests/machine.test.ts"}
```
The find exists only after the change. It matches once in the branch's `src/machine.ts`.

## Acceptance
- AC-1: a repo at its own cap waits while another repo still gets a machine slot, and the machine total still holds: checked by `make test FILES=tests/machine.test.ts` (T1)
- AC-2: the fleet view counts slots the same way with the new cap: checked by `make test FILES=tests/fleet.test.ts` (T1)
- AC-3: watchers that share a machine still dispatch under the machine cap: checked by `make test FILES=tests/machine-dispatch.test.ts` (T1)

## Non-goals
- NG-1: no per-repo cap other than `config.concurrency`, no new config key, and no change to pools or spend caps.
- NG-2: no change to `MachineLeases` storage or to the lease table.
- NG-3: do not touch `.github/workflows`, and do not edit `tests/mutations.json`; the mutation goes in `tests/mutations/` (#151).
- NG-4: one PR for this spec, whose body follows `.github/pull_request_template.md`. Every commit carries the `Signed-off-by:` line from `CONTRIBUTING.md`. No em dashes in code, comments or the PR. Touch nothing outside Files.

## Files
- `tests/mutations/machine-acquire-drops-the-per-repo-count.json` (new)
- `src/machine.ts` (edit: `acquire` takes a `LeaseCap` and counts the repo's leases; `effectiveSlots` deleted)
- `src/watch.ts` (edit: passes a `LeaseCap`)
- `tests/machine.test.ts` (edit: per-repo cap tests)
- `tests/fleet.test.ts` (edit: `LeaseCap` at two calls)
