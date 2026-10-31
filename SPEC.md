<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: operator

## Risk: medium

## Why
Two gaps in the gate. First (#327): `make check` reruns lint, typecheck and the whole test suite even when not one input changed since the last green run, on a laptop and in CI alike. A check whose inputs are byte-identical to a green run can replay that run's output instead, as long as any changed input always misses and every hit is visible. Second (#329): tests written during one factory run and tests the suite keeps get the same treatment. There is no written time budget per layer, and nothing decides whether a test a run added has earned its place: it must fail on base, pass on head three times, and kill a changed-line mutant.

This plan adds one input-hash cache wrapper that the Makefile puts in front of each lint, typecheck and test command, the layer budgets L0 to L4 in one module asserted against the workflows, and a promotion step that records, per new test file in a verify run, whether it is promoted or should be deleted at merge.

## Today
- `Makefile`: `check: lint typecheck test skills-check`. `lint` runs `bun x biome ci .`, `uvx reuse==6.2.0 lint --quiet`, a cargo-required guard line, then `cargo fmt` and `cargo clippy` for `verify/` and for `relay/`. `typecheck` is `bun x tsc --noEmit`. `test` is `$(GIT_ENV) bun test -t '^(?!.*@quarantine)' --reporter=junit --reporter-outfile=reports/junit.xml $(TEST_ARGS) $(FILES)`. `reports/` is gitignored.
- `tests/quarantine.test.ts` reads the `test:` recipe with `/bun test -t '([^']+)'/`; the mutation `quarantine: make test runs tagged tests` finds `bun test -t '^(?!.*@quarantine)'` in `Makefile`. Both must keep matching exactly once.
- `.github/workflows/ci.yml` runs `make check` in the `push` job with an empty `HOME`; `.github/workflows/flakes.yml` shows the `actions/cache/restore@v4` and `actions/cache/save@v4` pattern. `ci.yml` has `timeout-minutes: 20`, `flakes.yml` has `timeout-minutes: 30`, `mutations.yml` runs nightly on `17 3 * * *`.
- `src/engine/steps.ts` runs the proof, writes `proof.json`, then calls `recordVerifyFacts(worktree, config, issueNumber, testCmd, proof)` from `src/engine/verify-facts.ts`, which returns early unless the repo can merge on its own. `steps.ts` must stay at exactly 593 lines (`quality-baseline.json`), so this plan does not edit it.
- `src/proof.ts` exports `runProof(git, worktree, base, proof, testCmd)` (reverts implementation files, runs the command, `bites` when it fails), `ShellProofGit` and `isTestPath`. `src/config.ts` has `GateSpec.fileCmd` (the test runner for named files) and `testGate(gates)`.
- `src/changed-mutants.ts` exports `runChangedLineMutants(dir, diff, testCmd)` capped at `MAX_MUTANTS = 25`.

## Change
### T1: the input-hash cache wrapper
Files: `scripts/check-cache.ts`, `tests/check-cache.test.ts`
Model: sonnet
1. `scripts/check-cache.ts` opens with a three-line comment: a check whose inputs hash the same as a green run replays that run; any changed input misses; only a zero exit is stored. Usage: `bun scripts/check-cache.ts <name> [--in <pathspec>]... [--out <path>]... -- <cmd...>`, split at the first `--`. `<name>` matches `/^[a-z0-9-]+$/`, otherwise exit 2.
2. Exports `KEEP = 5`, `parseArgs(argv)`, `inputFiles(root, pathspecs, outs)`, `cacheKey(o)`, `shouldCache(argv, env)`, `prune(dir, name, keep = KEEP)` and `runCached(o): Promise<number>` where `o` is `{ root, name, ins, outs, argv, env }`.
3. `inputFiles` runs `git ls-files -co --exclude-standard -z -- <pathspecs or .>` in `root`, drops the `--out` paths and any path that no longer exists, and sorts. Blob ids come from one `git hash-object --stdin-paths` call over that list (paths holding a newline are dropped first).
4. `cacheKey` is the sha256 hex of `JSON.stringify` of `{ name, argv, bun: Bun.version, platform: process.platform, arch: process.arch, tool, files }` where `tool` is `""` when `argv[0]` is `bun`, otherwise the first line of `<argv[0]> --version` (`""` when that fails), and `files` is written exactly as `files: inputs.map((f, i) => [f, blobs[i]]),`.
5. `shouldCache(argv, env)` is `env.CHECK_CACHE !== "off" && !argv.some((a) => a.startsWith("--rerun-each"))`.
6. The store is `${env.CHECK_CACHE_DIR ?? join(root, "reports/check-cache")}/<name>-<key>.json` holding `{ name, key, at, stdout, stderr, outs: Record<path, base64> }`. `runCached` reads it with exactly `const hit = shouldCache(o.argv, o.env) && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Entry) : undefined;`. On a hit it writes each stored output back (creating its directory), writes the stored stdout and stderr to its own, prints `check-cache: hit <name> <key12>` to stderr and returns 0. On a miss it prints `check-cache: miss <name> <key12>` to stderr, spawns `argv` in `root` with the inherited environment and piped output, writes the output through, and when the exit is 0 and `shouldCache` holds, stores the entry (reading each `--out` file that exists) and calls `prune`. It returns the command's exit code. `<key12>` is the first 12 hex characters.
7. Both hit and miss lines are also appended as `- check-cache: <hit|miss> <name> <key12>` to `env.GITHUB_STEP_SUMMARY` when set.
8. `prune` deletes all but the newest `keep` files named `<name>-*.json` in the store, by mtime.
9. The `import.meta.main` block calls `parseArgs(process.argv.slice(2))`, exits 2 with the usage line on a bad name or no `--`, and exits with `runCached`'s code, `root` being `process.cwd()`.
10. `tests/check-cache.test.ts` makes a temp git repo (`git init`, one tracked file, `GIT_CONFIG_GLOBAL=/dev/null`) with the store in another temp directory through `CHECK_CACHE_DIR`. The command is `bash -c` appending a line to a counter file outside the repo and writing `out/result.txt`. It never uses `toBeTruthy` or similar loose matchers.

### T2: put the cache in front of the gate
Files: `Makefile`, `ci/ci.yml`
Model: sonnet
Deps: T1
1. `Makefile` gains `CACHE = bun scripts/check-cache.ts` above `lint:`, with a comment line: each check replays a green run whose inputs hash the same (`scripts/check-cache.ts`); `CHECK_CACHE=off make check` runs everything.
2. The `lint` recipe becomes, the guard line unchanged:
   ```make
   	$(CACHE) lint-biome -- bun x biome ci .
   	$(CACHE) lint-reuse -- uvx reuse==6.2.0 lint --quiet
   	@command -v cargo ... (unchanged)
   	$(CACHE) lint-fmt-verify --in verify -- cargo fmt --manifest-path verify/Cargo.toml --check
   	$(CACHE) lint-clippy-verify --in verify -- cargo clippy ... (rest of the current line unchanged)
   	$(CACHE) lint-fmt-relay --in relay -- cargo fmt --manifest-path relay/Cargo.toml --check
   	$(CACHE) lint-clippy-relay --in relay -- cargo clippy ... (rest of the current line unchanged)
   ```
3. `typecheck:` becomes `$(CACHE) typecheck -- bun x tsc --noEmit`.
4. The `test:` command becomes exactly `$(GIT_ENV) $(CACHE) test --out reports/junit.xml -- bun test -t '^(?!.*@quarantine)' --reporter=junit --reporter-outfile=reports/junit.xml $(TEST_ARGS) $(FILES)`. The `@mkdir -p reports` line stays. No new make target.
5. `ci/ci.yml` is a byte copy of `.github/workflows/ci.yml` with two steps added to the `push` job: directly before `make check`, `actions/cache/restore@v4` with `path: reports/check-cache`, `key: check-cache-${{ github.run_id }}`, `restore-keys: check-cache-`; directly after it, `actions/cache/save@v4` with `if: always()` and the same path and key. If `ci/ci.yml` already exists on the branch when this task starts, add the two steps to it instead of copying.

### T3: layer budgets in one module
Files: `src/test-layers.ts`, `tests/test-layers.test.ts`
Model: haiku
1. `src/test-layers.ts` opens with a two-line comment: the five test layers by time budget, and that `tests/test-layers.test.ts` holds the workflows to them. It exports `type LayerId = "L0" | "L1" | "L2" | "L3" | "L4"`, `interface Layer { readonly id: LayerId; readonly maxSeconds: number; readonly runs: string }`, and:
   ```ts
   export const LAYERS: readonly Layer[] = [
     { id: "L0", maxSeconds: 10, runs: "one test file while editing" },
     { id: "L1", maxSeconds: 60, runs: "the test files a change touches, before a commit" },
     { id: "L2", maxSeconds: 180, runs: "the pull request checks" },
     { id: "L3", maxSeconds: 1200, runs: "the full gate after merge, on main" },
     { id: "L4", maxSeconds: 1800, runs: "nightly: every mutation, and every test three times" },
   ];
   ```
   and `export function layerFor(seconds: number): LayerId { return LAYERS.find((l) => seconds < l.maxSeconds)?.id ?? "L4"; }`.
2. `tests/test-layers.test.ts` reads the live workflows under `.github/workflows/`.

### T4: the session-test promotion rule
Files: `src/promotion.ts`, `tests/promotion.test.ts`, `src/changed-mutants.ts`, `src/engine/verify-facts.ts`
Model: sonnet
Deps: T3
1. `src/changed-mutants.ts`: `runChangedLineMutants(dir, diff, testCmd)` gains a fourth parameter `max = MAX_MUTANTS` and its `.slice(0, MAX_MUTANTS)` becomes `.slice(0, max)`. Nothing else changes; existing callers pass three arguments.
2. `src/promotion.ts` opens with a three-line comment: a test file a run added is promoted only when it passes on head three times, fails on base, and kills a changed-line mutant (or the diff has no line to mutate); otherwise the record says delete; this module records, it never deletes. It exports `PROMOTION_FILE = "promotion.json"`, `MAX_PROMOTION_FILES = 3`, `HEAD_RUNS = 3`, `PROMOTION_MUTANTS = 5`, `interface Evidence { file: string; headPasses: number; failsOnBase: boolean; mutants: number; survived: number; seconds: number; layer: LayerId }`, `type Decision = "promote" | "delete"`, `interface PromotionDeps { git: ProofGit; mutants: typeof runChangedLineMutants; diff(worktree: string, base: string): Promise<string> }`, `newTestFiles(changes)`, `decide(e)`, `promote(deps, worktree, base, fileCmd)` and `recordPromotion(worktree, config, issue, proof, deps?)`.
3. `newTestFiles(changes)` keeps changes with status `A` whose path matches `/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$/` (a file under `tests/` that is not itself a test, such as a fixture, is not a session test), first `MAX_PROMOTION_FILES` in order.
4. `decide(e)` is exactly:
   ```ts
   const killsOrNothingToKill = e.mutants === 0 || e.survived < e.mutants;
   return e.headPasses === HEAD_RUNS && e.failsOnBase && killsOrNothingToKill ? "promote" : "delete";
   ```
5. `promote` takes the changes from `deps.git.changes(worktree, base)`, and for each new test file sets `cmd` to `` `${fileCmd} '${file.replaceAll("'", "'\\''")}'` ``, runs `deps.git.test(worktree, cmd)` `HEAD_RUNS` times counting exits of 0 and timing the first run in seconds, takes `failsOnBase` from `(await runProof(deps.git, worktree, base, "test", cmd)).status === "bites"`, and `mutants` and `survived` from `deps.mutants(worktree, await deps.diff(worktree, base), cmd, PROMOTION_MUTANTS)`. `layer` is `layerFor(seconds)`. It returns `{ file, decision: decide(e), evidence: e }[]`.
6. `recordPromotion` returns without writing when `proof.status !== "bites"` or `testGate(config.gates)?.fileCmd` is unset. Otherwise it runs `promote` with default deps (`new ShellProofGit()`, `runChangedLineMutants`, and a diff from `git diff -U0 <merge-base of HEAD and origin/<base>> HEAD`), and writes `{ decisions }` as pretty JSON to `<worktree>/<runDir(issue)>/promotion.json`. Any thrown error is logged with `console.error` and writes nothing.
7. `src/engine/verify-facts.ts`: `recordVerifyFacts` gains, as its first statement, `await recordPromotion(worktree, config, issue, proof);`, so the record is written for every repo with a `fileCmd`, before the merge-policy guard. Add the import. No other change in that file.
8. `tests/promotion.test.ts` drives `promote` with a fake `ProofGit` and a fake `mutants`, never a real repo.

### T5: wire and deliver
Files: `tests/mutations.json`
Model: haiku
Deps: T1, T2, T3, T4
1. `tests/mutations.json` gains the entries from ## Mutation, one per line in the file's existing `{"name": ..., "file": ..., "find": ..., "replace": ..., "test": ...},` style, inserted directly after the line whose name is `plane: a guest is not a member`. Append nothing at the end of the file.
2. Run `make check` twice in a row: the second run prints `check-cache: hit` for every cached step. Then `CHECK_CACHE=off make check` passes, and `make check-mutations MUTATION_ARGS="--base origin/main"` passes.
3. Delivery: one PR for this plan. The PR body fills every section of `.github/pull_request_template.md`, and its Gate evidence quotes the two `make check` runs' cache lines. Every commit carries a `Signed-off-by:` line (`git commit -s`). No em dashes in code, comments, docs or the PR body. No file outside ## Files changes. New tests use no `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined` or `expect.anything()`.

## Tests
- `tests/check-cache.test.ts`: [permanent] the first run misses and runs the command (counter 1); a second run hits, does not run it (counter still 1), restores a deleted `out/result.txt` and replays the stdout; editing the tracked file misses; an untracked, not ignored new file misses; a failing command is not stored and runs again next time; an argv holding `--rerun-each` and `CHECK_CACHE=off` always run; `prune` keeps the newest `KEEP`; the `Makefile` `lint`, `typecheck` and `test` recipes each run through `$(CACHE)`, and `.github/workflows/ci.yml` or `ci/ci.yml` restores and saves `reports/check-cache`.
- `tests/test-layers.test.ts`: [permanent] `LAYERS` ids are `L0` to `L4` in order with strictly rising budgets, L0 is 10 s, L1 60 s, L2 180 s; `layerFor(9)` is `L0`, `layerFor(10)` is `L1`, `layerFor(5000)` is `L4`; the `push` job's `timeout-minutes` in `ci.yml` times 60 equals L3's budget; `flakes.yml`'s `timeout-minutes` times 60 equals L4's budget; `mutations.yml` and `flakes.yml` each have a `schedule`.
- `tests/promotion.test.ts`: [permanent] a new test that passes three times, bites on base and kills one of two mutants is promoted; one that fails once on head, one that passes on base, and one that kills no mutant are each `delete`; a diff with no mutable line promotes on the other three; a fixture under `tests/fixtures/` and a modified test are not session tests; at most three files are judged; `recordPromotion` writes nothing when the proof did not bite or there is no `fileCmd`.

## Mutation
```json
{"name":"check cache: a stored green run is replayed","file":"scripts/check-cache.ts","find":"const hit = shouldCache(o.argv, o.env) && existsSync(path) ? (JSON.parse(readFileSync(path, \"utf8\")) as Entry) : undefined;","replace":"const hit = undefined as Entry | undefined;","test":"tests/check-cache.test.ts"}
```
```json
{"name":"check cache: a changed input misses","file":"scripts/check-cache.ts","find":"files: inputs.map((f, i) => [f, blobs[i]]),","replace":"files: [],","test":"tests/check-cache.test.ts"}
```
```json
{"name":"check cache: a rerun is never cached","file":"scripts/check-cache.ts","find":"!argv.some((a) => a.startsWith(\"--rerun-each\"))","replace":"true","test":"tests/check-cache.test.ts"}
```
```json
{"name":"layers: a budget is an upper bound","file":"src/test-layers.ts","find":"seconds < l.maxSeconds","replace":"seconds <= l.maxSeconds","test":"tests/test-layers.test.ts"}
```
```json
{"name":"promotion: a test must pass on head three times","file":"src/promotion.ts","find":"e.headPasses === HEAD_RUNS && e.failsOnBase","replace":"e.failsOnBase","test":"tests/promotion.test.ts"}
```

## Acceptance
- AC-1: lint, typecheck and the test suite are each keyed on a hash of their inputs, a changed input always misses, a failed or rerun check is never stored, and every hit and miss is printed and written to the run summary: checked by `tests/check-cache.test.ts` (T1)
- AC-2: the Makefile puts every lint, typecheck and test command behind the cache and CI keeps the store between runs: checked by `tests/check-cache.test.ts` (T2)
- AC-3: the layer budgets L0 to L4 live in one module and the workflow timeouts and schedules match them: checked by `tests/test-layers.test.ts` (T3)
- AC-4: each test file a run adds gets a recorded promote or delete decision from three head runs, a base run and changed-line mutants: checked by `tests/promotion.test.ts` (T4)

## Non-goals
- NG-1: no edit to `.github/workflows/`; the build stages `ci/ci.yml` and the operator moves it, then deletes `ci/`.
- NG-2: nothing deletes a session test at merge yet; `promotion.json` records the decision, and acting on it is a follow-up.
- NG-3: no edit to `src/engine/steps.ts`, `src/proof.ts` or `src/config.ts`.
- NG-4: no per-file test selection inside the cache: the `test` key covers the whole tree, so any change reruns the suite.
- NG-5: `skills-check` is not cached: it fetches a validator over the network.
- NG-6: the 3-minute PR budget (L2) is stated, not timed.
- NG-7: no new dependency.

## Files
- `scripts/check-cache.ts` (new)
- `tests/check-cache.test.ts` (new)
- `src/test-layers.ts` (new)
- `tests/test-layers.test.ts` (new)
- `src/promotion.ts` (new)
- `tests/promotion.test.ts` (new)
- `ci/ci.yml` (new)
- `Makefile` (edit: `CACHE` in front of lint, typecheck and test)
- `src/changed-mutants.ts` (edit: a `max` parameter)
- `src/engine/verify-facts.ts` (edit: call `recordPromotion`)
- `tests/mutations.json` (edit: add the five entries after the plane entries)
