<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: operator

## Risk: medium

## Why
Two gaps in how the factory proves its own checks bite. First (#326): a pull request runs only the curated mutations in `tests/mutations.json` whose file or test the diff touched, so a changed source line that no test checks merges unseen; nothing mutates the lines a PR actually changed. Second (#328): the PR selection skips mutations, and nobody measures what it skips. A mutation that the full run on main finds broken, but the PR selection would not have run, is a selector miss; today it is invisible.

This plan adds a PR check that makes one mutant per changed source line (capped at 30) and runs only the tests that import the mutated file, a post-merge step that compares the full run on main with what the PR selection would have run and records every miss as a row, opens an issue per miss and names the exact `inputs` line that would have caught it, and an optional `inputs` list per mutation entry so the selection tightens when that line is added. Unchanged code is not re-mutated on a PR: its verdict comes from the full run on main and the nightly run.

## Today
- `scripts/check-mutations.ts` (113 lines) runs every entry of `tests/mutations.json` in temp copies of the repo (`copyRepo`, a `SKIP` set, a `node_modules` symlink). With `--base <ref>` it narrows the list with `selectMutations` from `scripts/mutation-select.ts`. Its top-level code runs on import, so nothing can import it. The positional argument detection treats any non-flag word that is not the `--base` value as a mutation name.
- `scripts/mutation-select.ts` selects an entry when the diff touched `m.file` or `m.test`, or when the list changed and the entry is new or edited. A change to `scripts/check-mutations.ts` or `scripts/mutation-select.ts` runs everything (`RUNS_ALL`).
- `.github/workflows/mutations.yml` runs `make check-mutations` with `--base origin/<base>` on a PR and the full list on a push to main (path filtered to `tests/**`, `src/**`, the runner and the workflow) and nightly at `17 3 * * *`. Measured runtime on recent runs: a PR run takes about 10 to 20 seconds, a full run about 4 to 5 minutes. The "14 to 19 minutes" in #326 predates the selection.
- `src/changed-mutants.ts` exports `mutantsFor(diff, read)` (one mutant per added line in a source file, test paths skipped, comment and import lines skipped) and `runChangedLineMutants` for target repos. Nothing runs changed-line mutants on the factory's own PRs.
- `scripts/kaas/check-affected.py` has no `impact` map in this repo, so the only selector to measure is the mutation selector.
- `tests/ci-wiring.test.ts` has a `runs(script, files)` helper that accepts the live workflow or its staged copy under `ci/`.

## Change
### T1: shared repo copy and the import graph
Files: `scripts/repo-copy.ts`, `scripts/import-graph.ts`, `tests/import-graph.test.ts`, `scripts/check-mutations.ts`
Model: sonnet
1. `scripts/repo-copy.ts` opens with a one-line comment and exports `ROOT = join(import.meta.dir, "..")`, `SKIP` (the exact set now in `scripts/check-mutations.ts`) and `copyRepo(root = ROOT, prefix = "factory-mutant-"): string`, which is the current `copyRepo` body with `ROOT` replaced by `root` and the prefix passed to `mkdtempSync`.
2. `scripts/check-mutations.ts` imports `ROOT` and `copyRepo` from `./repo-copy` and drops its own `ROOT`, `SKIP` and `copyRepo`; it calls `copyRepo()` unchanged. No other behaviour changes in this task.
3. `scripts/import-graph.ts` opens with a two-line comment (what a closure is, and that only relative imports count). It exports:
   - `const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;` (module constant, not exported).
   - `resolveImport(fromFile: string, spec: string, exists: (p: string) => boolean): string | undefined`: joins `dirname(fromFile)` and `spec` with `node:path` `join`, normalised to a forward-slash repo-relative path, then returns the first of `p`, `p.ts`, `p.tsx`, `p.js`, `p/index.ts` for which `exists` is true; a `spec` ending in `.js` also tries the same path with `.ts`. A path that starts with `..` (outside the root) is `undefined`.
   - `importsOf(file: string, text: string, exists): string[]`: every `SPEC` match resolved, `undefined` dropped, duplicates dropped, in source order.
   - `importClosure(entry: string, root: string): Map<string, number>`: breadth first from `entry` at depth 0, reading files with `readFileSync(join(root, f), "utf8")` and `exists = (p) => existsSync(join(root, p))`. The loop body over a file's imports is written exactly as:
     ```ts
     for (const dep of importsOf(file, read(file), exists)) {
       if (depth.has(dep)) continue;
       depth.set(dep, depth.get(file)! + 1);
       queue.push(dep);
     }
     ```
     An unreadable file contributes no imports. Nothing else in the file contains the text `queue.push(dep);`.
   - `testFiles(root: string): string[]`: every `*.test.ts` under `tests/`, repo-relative, sorted, skipping any path with a `fixtures` segment.
   - `coveringTests(file: string, tests: readonly string[], root: string): string[]`: the tests whose closure holds `file`, sorted by that depth, then by name. Closures are memoised per `root` and test in a module `Map`.
4. `tests/import-graph.test.ts` builds a small tree in a `mkdtempSync` directory with `writeFileSync` (no fixture files): `src/a.ts` imports `./b` with `from`, `src/b.ts` imports `./c/index` through `import("./c")`, `src/c/index.ts` imports nothing, `src/d.ts` is never imported, `tests/a.test.ts` imports `../src/a`, `tests/d.test.ts` imports `../src/d.js`.

### T2: optional inputs per mutation and a run report
Files: `scripts/mutation-select.ts`, `tests/mutation-select.test.ts`, `scripts/check-mutations.ts`
Model: sonnet
Deps: T1
1. `Scoped` in `scripts/mutation-select.ts` gains `readonly inputs?: readonly string[];` with a one-line comment: files the test reads that are neither `file` nor `test`, added when a selector miss names them.
2. `RUNS_ALL` gains `"scripts/repo-copy.ts"`.
3. The filter becomes, keeping every existing line intact and adding one condition before the list clause:
   ```ts
   touched.has(m.file) ||
   touched.has(m.test.replace(/^\.\//, "")) ||
   (m.inputs ?? []).some((f) => touched.has(f)) ||
   (touched.has(LIST) && !known.has(JSON.stringify(m))),
   ```
4. `tests/mutation-select.test.ts` gains one test: an entry with `inputs: ["src/shared.ts"]` is selected by a diff of only `src/shared.ts`, and an entry without it is not.
5. `scripts/check-mutations.ts`: the `Mutation` interface gains `readonly inputs?: readonly string[];`. Argument parsing becomes exactly:
   ```ts
   const valueOf = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
   const base = valueOf("--base");
   const report = valueOf("--report");
   const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base" && args[i - 1] !== "--report");
   ```
   replacing `baseAt`, `base` and `only`. Next to `failures`, keep `const failedNames: string[] = [];` and push `m.name` whenever a problem is pushed. Before the `if (failures.length)` block, when `report` is set, `mkdirSync(dirname(report), { recursive: true })` and write `JSON.stringify({ selected: selected.map((m) => m.name), failed: failedNames }, null, 2)` to it.

### T3: one mutant per changed line on a pull request
Files: `scripts/check-changed-mutants.ts`, `tests/check-changed-mutants.test.ts`
Model: sonnet
Deps: T1
1. `scripts/check-changed-mutants.ts` opens with a three-line comment: one mutant per changed source line, only the tests that import the file run, and a line whose mutant is equivalent carries a `mutant-ok: <why>` comment. It exports `MAX_PR_MUTANTS = 30`, `MAX_COVERING = 5`, `inScope(file)`, `prMutants(diff, read)`, `type Outcome = "killed" | "survived" | "uncovered"`, `interface Result { mutant: Mutant; outcome: Outcome; tests: string[] }`, `runMutant(dir, mutant, tests)` and `summary(results)`.
2. `inScope(file)` is `/^(src|scripts|dashboard)\/.*\.ts$/.test(file) && !file.startsWith("scripts/kaas/") && !file.includes("/fixtures/")`.
3. `prMutants` is exactly `mutantsFor(diff, read).filter((m) => inScope(m.file) && !m.before.includes("mutant-ok:")).slice(0, MAX_PR_MUTANTS)`, reusing `mutantsFor` and `Mutant` from `src/changed-mutants.ts` unchanged.
4. `runMutant(dir, m, tests)` writes the mutated line into `join(dir, m.file)`, runs `bun test --bail ...tests` with `cwd: dir`, stdout and stderr ignored, restores the original text in a `finally`, and ends with exactly `return code === 0 ? "survived" : "killed";`.
5. `summary(results)` returns a Markdown table with columns `Line`, `Outcome`, `Tests` and a first line `check-changed-mutants: <killed> killed, <survived> survived, <uncovered> uncovered`.
6. The `import.meta.main` block requires `--base <ref>` (exit 2 with a usage line otherwise), runs `git diff --unified=0 --no-color <base>...HEAD` in `ROOT`, builds `prMutants` reading files from `ROOT`, and prints `check-changed-mutants: no changed source line to mutate` and exits 0 when there are none. It finds each mutant's tests with `coveringTests(m.file, testFiles(ROOT), ROOT).slice(0, MAX_COVERING)`; a mutant with none is `uncovered` and runs nothing. It runs the union of all covering tests once, unmutated, in the first copy and exits 1 with `covering tests fail before any mutation` when that is red. Mutants then run in `min(Number(process.env.MUTATION_WORKERS) || availableParallelism(), count)` workers, each with its own `copyRepo(ROOT, "factory-pr-mutant-")` removed in a `finally`. It prints one line per mutant (`killed`, `SURVIVED`, `uncovered`, the `file:line` and the tests), appends `summary` to `GITHUB_STEP_SUMMARY` when that variable is set, and exits 1 when any mutant survived with: `check-changed-mutants: <n> of <m> mutants survived: a changed line no test checks. Add a test, or mark an equivalent mutant with a "mutant-ok: <why>" comment on that line.` Uncovered lines are reported, never failed.
7. `tests/check-changed-mutants.test.ts` builds a temp repo with `writeFileSync`: `src/x.ts` exporting `export const big = (n: number) => n >= 10;` and a test file under its `tests/` that imports it. One test file asserts `big(10)` and `big(9)` (kills the `>=` mutant); a second asserts only `typeof big` (lets it survive). `runMutant` returns `killed` with the first and `survived` with the second. Pure cases: `inScope` for `src/a.ts` (true), `scripts/kaas/x.ts`, `tests/a.test.ts`, `src/fixtures/a.ts`, `src/a.tsx` (all false); `prMutants` caps at `MAX_PR_MUTANTS` for a 40-line diff and drops a code line such as `return a === b; // mutant-ok: equivalent` while keeping the same line without the comment.

### T4: selector misses after merge
Files: `scripts/selector-misses.ts`, `tests/selector-misses.test.ts`
Model: sonnet
Deps: T1, T2
1. `scripts/selector-misses.ts` opens with a two-line comment: a selector miss is a mutation that failed in the full run on main that the PR selection for the same diff would not have run; the miss rate says whether the selection can be trusted. It exports `selectorMisses(all, failed, changed, before?)`, `suggestedInputs(test, changed, root)`, `missTitle(name)`, `missBody(m, sha, changed, inputs)` and `interface MissRow { at: string; sha: string; before: string; failed: number; misses: string[] }`.
2. `selectorMisses` is written as:
   ```ts
   const picked = new Set(selectMutations(all, changed, before).map((m) => m.name));
   return failed.filter((name) => !picked.has(name));
   ```
3. `suggestedInputs(test, changed, root)` returns the changed files inside `importClosure(test, root)` other than the test itself, or the first 10 changed files when none are.
4. `missTitle(name)` is `` `Selector miss: ${name}` ``. `missBody` holds the commit sha, the changed files, and the exact line to add to the entry in `tests/mutations.json`: `"inputs": [<suggested files, JSON quoted>]`.
5. The `import.meta.main` block takes `--before <sha> --report <path> [--open-issues]`. A missing report, or a `--before` of all zeros, prints a one-line reason and exits 0. Otherwise it reads `tests/mutations.json` at HEAD, the list at `<before>` via `git show <before>:tests/mutations.json` (undefined when that fails), the changed files from `git diff --name-only <before>...HEAD`, and the report's `failed`. It appends one `MissRow` as a JSON line to `reports/selector-misses.jsonl`, prints a Markdown table of this push's misses and the running miss rate across every row in that file (total misses over total failures, `0` when there were no failures). With `--open-issues`, for each miss it lists open issues with `gh issue list --state open --search "<title> in:title" --json title`, and when none has that exact title runs `gh issue create --title <title> --body <body>` with no labels. It exits 0 whatever it found: the full run's own step already fails the workflow.
6. `tests/selector-misses.test.ts` uses inline lists: a failed mutation whose `file` is in the diff is not a miss; one whose test imports a changed file through a helper but whose `file` and `test` are untouched is a miss; adding the suggested `inputs` to that entry makes it selected, so it is no longer a miss; `missBody` contains the `"inputs": [` line.

### T5: stage the workflow and assert the wiring
Files: `ci/mutations.yml`, `tests/ci-wiring.test.ts`, `tests/mutations.json`
Model: sonnet
Deps: T2, T3, T4
1. `ci/mutations.yml` is `.github/workflows/mutations.yml` with these changes and nothing else: the header comment says a PR runs the mutations its diff reaches plus one mutant per changed source line, a push to main runs every mutation and logs selector misses, and the nightly run is the full list; the `push` trigger keeps `branches: [main]` and drops its `paths` filter, so every merge is measured; the `check-mutations` job gains `permissions: { contents: read, issues: write }`; before `make check-mutations` it restores `reports/selector-misses.jsonl` with `actions/cache/restore@v4` (key `selector-misses-${{ github.run_id }}`, restore key `selector-misses-`, `if: github.event_name == 'push'`); the `MUTATION_ARGS` expression's fallback changes from `''` to `'--report reports/mutations-report.json'`; after it, a step `Selector misses on this push` with `if: always() && github.event_name == 'push'` and `env: GH_TOKEN: ${{ github.token }}` runs `bun scripts/selector-misses.ts --before "${{ github.event.before }}" --report reports/mutations-report.json --open-issues >> "$GITHUB_STEP_SUMMARY"`; then `actions/cache/save@v4` with `if: always() && github.event_name == 'push'` and the same path and key. A second job `changed-mutants`, `if: github.event_name == 'pull_request'`, `runs-on: ubuntu-latest`, `timeout-minutes: 10`, checks out with `fetch-depth: 0`, sets up bun `"1.3"`, runs `make install`, then a step `One mutant per changed source line` running `bun scripts/check-changed-mutants.ts --base "origin/${{ github.base_ref }}"`.
2. `tests/ci-wiring.test.ts` gains two tests in the existing `describe`, using `runs`: `scripts/check-changed-mutants.ts` and `scripts/selector-misses.ts` are each run by `.github/workflows/mutations.yml` or `ci/mutations.yml`.
3. `tests/mutations.json` gains the entries from ## Mutation, one per line in the file's existing `{"name": ..., "file": ..., "find": ..., "replace": ..., "test": ...},` style, inserted directly after the line whose name is `mutation select: a list edit runs only new or changed entries`. Append nothing at the end of the file: other plans insert there.
4. Before opening the PR, run `make check`, `make check-mutations MUTATION_ARGS="--base origin/main"` and `bun scripts/check-changed-mutants.ts --base origin/main`; all three exit 0. A survivor on a line this plan added gets a test, not a waiver.
5. Delivery: one PR for this plan. The PR body fills every section of `.github/pull_request_template.md`. Every commit carries a `Signed-off-by:` line (`git commit -s`). No em dashes in code, comments, docs or the PR body. No file outside ## Files changes. New tests use no `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined` or `expect.anything()`.

## Tests
- `tests/import-graph.test.ts`: [permanent] `importClosure("tests/a.test.ts")` holds `src/a.ts` at depth 1, `src/b.ts` at 2 and `src/c/index.ts` at 3, and not `src/d.ts`; `coveringTests("src/c/index.ts")` is `["tests/a.test.ts"]`; `coveringTests("src/d.ts")` is `["tests/d.test.ts"]` (the `.js` spec resolves to `.ts`); a spec that resolves outside the root is dropped; `testFiles` skips a `fixtures` path.
- `tests/mutation-select.test.ts`: [permanent] an entry's `inputs` select it.
- `tests/check-changed-mutants.test.ts`: [permanent] a real `bun test` run kills a checked mutant and reports an unchecked one as survived; scope, cap and waiver cases.
- `tests/selector-misses.test.ts`: [permanent] a mutation reached only through an import is a miss until its `inputs` line is added.
- `tests/ci-wiring.test.ts`: [permanent] both new scripts are wired into the mutations workflow, staged or live.

## Mutation
```json
{"name":"import graph: a transitive import is followed","file":"scripts/import-graph.ts","find":"queue.push(dep);","replace":"","test":"tests/import-graph.test.ts"}
```
```json
{"name":"mutation select: an entry's inputs select it","file":"scripts/mutation-select.ts","find":"(m.inputs ?? []).some((f) => touched.has(f))","replace":"false","test":"tests/mutation-select.test.ts"}
```
```json
{"name":"changed mutants: a passing mutant survives","file":"scripts/check-changed-mutants.ts","find":"return code === 0 ? \"survived\" : \"killed\";","replace":"return \"killed\";","test":"tests/check-changed-mutants.test.ts"}
```
```json
{"name":"changed mutants: a mutant-ok line is skipped","file":"scripts/check-changed-mutants.ts","find":"!m.before.includes(\"mutant-ok:\")","replace":"true","test":"tests/check-changed-mutants.test.ts"}
```
```json
{"name":"selector misses: an unselected failure is a miss","file":"scripts/selector-misses.ts","find":"failed.filter((name) => !picked.has(name))","replace":"failed.filter(() => false)","test":"tests/selector-misses.test.ts"}
```

## Acceptance
- AC-1: a test's import closure follows relative, dynamic and `.js` imports transitively, and the covering tests of a file are ordered by depth: checked by `tests/import-graph.test.ts` (T1)
- AC-2: a mutation entry's `inputs` select it when the diff touches one of them: checked by `tests/mutation-select.test.ts` (T2)
- AC-3: a PR makes at most 30 mutants on changed source lines, runs only the tests that import the file, fails on a survivor and skips a `mutant-ok:` line: checked by `tests/check-changed-mutants.test.ts` (T3)
- AC-4: a failure in the full run on main that the PR selection would have skipped is recorded as a miss with the `inputs` line that would have caught it: checked by `tests/selector-misses.test.ts` (T4)
- AC-5: the changed-line check runs on every PR and the miss log runs after every push to main: checked by `tests/ci-wiring.test.ts` (T5)

## Non-goals
- NG-1: no edit to `.github/workflows/`; the build stages `ci/mutations.yml` and the operator moves it over `.github/workflows/mutations.yml`, then deletes `ci/`.
- NG-2: the 3-minute PR budget is a target, not asserted; nothing times the job.
- NG-3: no stored per-line mutant results from main: unchanged code is not re-mutated on a PR, and its verdict is the full run on main and the nightly run.
- NG-4: no change to `src/changed-mutants.ts` or to the changed-line mutants the factory runs on target repos.
- NG-5: no `impact` map for `scripts/kaas/check-affected.py`; the measured selector is the mutation selector, and its map is the `inputs` field.
- NG-6: selector misses open issues; nothing edits `tests/mutations.json` automatically.
- NG-7: no new dependency.

## Files
- `scripts/repo-copy.ts` (new)
- `scripts/import-graph.ts` (new)
- `tests/import-graph.test.ts` (new)
- `scripts/check-changed-mutants.ts` (new)
- `tests/check-changed-mutants.test.ts` (new)
- `scripts/selector-misses.ts` (new)
- `tests/selector-misses.test.ts` (new)
- `ci/mutations.yml` (new)
- `scripts/check-mutations.ts` (edit: shared repo copy, `inputs`, `--report`)
- `scripts/mutation-select.ts` (edit: `inputs` and `RUNS_ALL`)
- `tests/mutation-select.test.ts` (edit: one test)
- `tests/ci-wiring.test.ts` (edit: two tests)
- `tests/mutations.json` (edit: add the five entries after the mutation select entries)
