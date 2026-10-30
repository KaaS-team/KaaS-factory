<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: operator

## Risk: medium

## Why
Two gaps let a weaker test suite merge. First (#330): a diff that only touches tests, or one that deletes a test, removes an assertion, adds a skip or swaps a strict matcher for a loose one, passes every diff-based check, because those checks look at what the code does, not at what the tests stop checking. Second (#331): there is no written rule for a flaky test. A test is tagged `@quarantine` by hand, with no owner, no expiry and no count of how often it flipped, so a quarantined test can sit skipped forever and a flaky one can keep failing pushes at random.

This plan adds one deterministic check that demands a stated reason for a weakening test change, a quarantine ledger with owner and expiry enforced by a test, and a nightly flake report that counts flips and names the tests that must be quarantined. It reuses the existing `@quarantine` tag, `make quarantine` target and `quarantine` CI job; it adds no second mechanism.

## Today
- `scripts/check-pr-body.ts` is the shape of a PR check: a pure exported `problems(...)` plus an `import.meta.main` block reading `PR_BODY`; `tests/check-pr-body.test.ts` drives the pure function. `scripts/dco.ts` takes `<base> [head]` and reads commits between them.
- `.github/workflows/ci.yml:40` runs `bun scripts/check-pr-body.ts` in the `push` job on pull requests. Nothing reads the diff of a test file.
- `Makefile:30` documents the tag: a flaky test is named `@quarantine`. `Makefile:35` runs `bun test -t '^(?!.*@quarantine)'` so `make test` skips tagged tests and writes `reports/junit.xml`. `Makefile:37` (`make quarantine`) runs only tagged tests.
- `.github/workflows/ci.yml:82` (CTRF reporter) shows a flaky-rate table from the last runs' junit reports; it records nothing and never fails. `.github/workflows/ci.yml:99` is the `quarantine` job, `continue-on-error: true`, running `make quarantine`.
- No test in `tests/` carries `@quarantine` today, and there is no ledger of who owns a quarantined test or when it must come back.
- `.github/workflows/mutations.yml` already runs nightly at `17 3 * * *`; there is no nightly test rerun.
- `bun test --rerun-each 3 --reporter=junit` (bun 1.3) writes one `<testcase>` per run, so the same `file` and `name` appear three times in one report.

## Change
### T1: tests-only and weakening check
Files: `scripts/check-tests-only.ts`, `tests/check-tests-only.test.ts`, `tests/fixtures/tests-only/only-tests.diff`, `tests/fixtures/tests-only/deleted-test.diff`, `tests/fixtures/tests-only/removed-assertion.diff`, `tests/fixtures/tests-only/new-skip.diff`, `tests/fixtures/tests-only/loose-matcher.diff`, `tests/fixtures/tests-only/clean.diff`
Model: sonnet
1. `scripts/check-tests-only.ts` opens with a two-line comment in the style of `scripts/check-pr-body.ts` and exports `KINDS = ["only-tests", "deleted-test", "removed-assertion", "new-skip", "loose-matcher"] as const`, `type Kind`, `interface Finding { kind: Kind; file: string; detail: string }`, `isTestFile(path)`, `parseDiff(text)`, `findings(files)` and `problems(diff, body)`.
2. `isTestFile` is true for a path under a `tests/` or `test/` directory, or ending in `.test.<ext>`, `.spec.<ext>` (ext one of `ts`, `tsx`, `js`, `jsx`, `mts`, `cts`, `mjs`, `cjs`), `_test.go`, `_test.py`, or a `test_*.py` basename.
3. `parseDiff` reads `git diff --unified=0` output and returns `DiffFile { path: string; deleted: boolean; added: string[]; removed: string[] }` per `diff --git` header, taking `path` from the `b/` side (the `a/` side when the file is deleted), and dropping the `+++` and `---` header lines.
4. The patterns are module constants written exactly as these lines:
   - `const ASSERTION = /\b(?:expect|assert)\s*\(|\bassert\.\w+\s*\(/;`
   - `const TEST_DECL = /\b(?:test|it)(?:\.\w+)?\s*\(\s*["'\x60]/;` (the `\x60` is a backtick)
   - `const SKIP = /\b(?:test|it|describe)\.(?:skip|todo|skipIf)\b|@quarantine/;`
   - `const LOOSE = /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)\(\)|expect\.anything\(\)/;`
5. `findings(files)` returns, in this order: `only-tests` once when `files` is non-empty and every path is a test file, written as exactly this line: `if (files.length > 0 && files.every((f) => isTestFile(f.path))) out.push({ kind: "only-tests", file: "", detail: "every changed file is a test" });`. Then, for each test file only: `deleted-test` when the file is deleted or its removed `TEST_DECL` lines outnumber its added ones; `removed-assertion` when its removed `ASSERTION` lines outnumber its added ones (a rewritten assertion is not a removal), with `detail` naming the net count and the first removed line; `new-skip` for each added line matching `SKIP`; `loose-matcher` for each added line matching `LOOSE`.
6. The body states a reason with a line `Test change reason: <text>` of at least 10 characters after the colon, matched by `const REASON = /^Test change reason:[ \t]*(\S.{9,})$/m;`. `problems(diff, body)` returns `[]` when there are no findings or the reason line is present, and otherwise one plain sentence per finding, `"<kind>: <file>: <detail>"`, followed by `'state why in a "Test change reason:" line in the PR body'`.
7. The `import.meta.main` block takes `<base> <head>` like `scripts/dco.ts`, runs `git diff --unified=0 --no-color <base>...<head>`, reads `PR_BODY`, prints `check-tests-only: ok`, or prints the findings under `check-tests-only: reason given:` and exits 0 when a reason is present, or prints the problems to stderr and exits 1.
8. Each fixture is a small hand-written `git diff --unified=0` that trips exactly the kind in its file name, except `only-tests.diff`, which may also trip others, and `clean.diff`, which changes one `src/` file and one test file and trips nothing. `new-skip.diff` uses `test.skip`, and `tests/check-tests-only.test.ts` never holds the literal quarantine tag, so `make quarantine`'s `grep -rl` never selects it.

### T2: quarantine ledger with owner and expiry
Files: `scripts/quarantine.ts`, `tests/quarantine.json`, `tests/quarantine.test.ts`
Model: sonnet
1. `tests/quarantine.json` is a JSON array, `[]` today. Each entry is `{ "file": "tests/x.test.ts", "test": "<the full test name, tag included>", "owner": "@login", "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD", "issue": "#n" }`.
2. `scripts/quarantine.ts` opens with a comment naming the policy: a test that flips is tagged, owned and given an expiry; the tag stays the one `Makefile` filters on. It exports `QUARANTINE_TAG`, built as `"@" + "quarantine"` so the file does not itself contain the literal tag, `MAX_DAYS = 30`, `interface Entry`, `loadLedger(path = "tests/quarantine.json")`, `tagged(dir = "tests")` and `quarantineProblems(entries, taggedTests, today)`.
3. `tagged(dir)` walks every `*.test.ts` under `dir` and returns `{ file, test }` for each `test(` or `it(` call whose first string argument contains `QUARANTINE_TAG`.
4. `quarantineProblems` returns one plain sentence per problem: a tagged test with no entry; an entry whose test is no longer tagged (stale); an entry missing `owner`, `added`, `expires` or `issue`; an `owner` not starting with `@`; a date that is not `YYYY-MM-DD`; `expires` more than `MAX_DAYS` after `added`; and an expired entry. The expiry check is a line that begins exactly `if (entry.expires < today) out.push(` and pushes a sentence naming the file, the test and the date, ending `fix it, delete it, or renew it with a new expiry`.
5. `tests/quarantine.test.ts` must not contain the literal tag, so `make quarantine`'s `grep -rl` never selects it; it builds names with `QUARANTINE_TAG`.

### T3: nightly flake report
Files: `scripts/flake-report.ts`, `tests/flake-report.test.ts`, `tests/fixtures/flakes/rerun.xml`, `tests/fixtures/flakes/history.json`
Model: sonnet
Deps: T2
1. `scripts/flake-report.ts` exports `FLAKE_LIMIT = 3`, `parseJunit(xml)`, `flakesIn(runs)`, `record(history, flakes, today)` and `mustQuarantine(history, runs)`.
2. `parseJunit` returns `Map<string, { pass: number; fail: number }>` keyed `` `${file}::${name}` ``; a `<testcase>` with a `<failure` or `<error` child counts as a fail, a `<skipped` child is ignored, anything else is a pass. Repeated testcases from `--rerun-each` add up.
3. `flakesIn(runs)` returns the keys that both passed and failed in this report, written with exactly this condition: `runs.pass > 0 && runs.fail > 0`.
4. History is `Record<string, { count: number; last: string }>`. `record` adds 1 to `count` and sets `last` to `today` for each flake, and returns a new object.
5. `mustQuarantine(history, runs)` returns the keys with `count >= FLAKE_LIMIT` that ran in this report; a tagged test does not run under `make test`, so tagging it clears it from the list without editing history.
6. The `import.meta.main` block takes `<history.json> <junit.xml>...`, reads the history (an absent file is `{}`), writes the updated history back, prints a Markdown table of this run's flakes with their counts to stdout, and exits 1 listing each `mustQuarantine` key as `quarantine <file> "<name>": flaked <n> times; tag it and add an entry to tests/quarantine.json`.
7. `tests/fixtures/flakes/rerun.xml` is a bun junit report of `--rerun-each 3` with one steady test, one test that flips, and one skipped test. `tests/fixtures/flakes/history.json` holds the flipping test at `FLAKE_LIMIT - 1`.

### T4: wire both checks and stage the workflows
Files: `ci/ci.yml`, `ci/flakes.yml`, `Makefile`, `CONTRIBUTING.md`, `tests/ci-wiring.test.ts`
Model: sonnet
Deps: T1, T2, T3
1. `ci/ci.yml` is a byte copy of `.github/workflows/ci.yml` with two steps added to the `push` job. After the PR body step: `A weakening test change states its reason (CONTRIBUTING.md)`, `if: github.event_name == 'pull_request'`, `env: PR_BODY`, running `bun scripts/check-tests-only.ts "origin/${{ github.base_ref }}" "${{ github.event.pull_request.head.sha }}"`. After the CTRF step, so it does not overwrite the report that step reads: `New and changed tests run three times`, on pull requests only, which lists added or modified `*.test.ts` files under `tests/` against the base and, when the list is not empty, runs `make test FILES="$changed" TEST_ARGS="--rerun-each 3"` with the same `HOME` and cargo env as the `make check` step.
2. `ci/flakes.yml` is a new workflow `flakes`: `schedule` at `47 3 * * *` and `workflow_dispatch`, one job on `ubuntu-latest`, `timeout-minutes: 30`. It checks out, sets up bun 1.3, installs tmux, runs `make install`, restores `reports/flakes-history.json` with `actions/cache` (key `flakes-history-${{ github.run_id }}`, restore key `flakes-history-`), runs `make test TEST_ARGS="--rerun-each 3" || true`, then `bun scripts/flake-report.ts reports/flakes-history.json reports/junit.xml >> "$GITHUB_STEP_SUMMARY"`, and saves the cache with `if: always()` so the counts persist even when the report fails the run.
3. `Makefile`: the `test` recipe gains `$(TEST_ARGS)` before `$(FILES)`, and the comment above it gains one line: a test that flips in the nightly `flakes` run `FLAKE_LIMIT` times must be tagged and get an entry in `tests/quarantine.json` (owner, expiry); `tests/quarantine.test.ts` fails on a tag with no entry or an expired one.
4. `CONTRIBUTING.md` gains two short paragraphs in its existing voice: a PR that only changes tests, deletes a test, removes an assertion, adds a skip or loosens a matcher carries a `Test change reason:` line, which CI checks with `bun scripts/check-tests-only.ts`; and the flake rule from step 3.
5. `tests/ci-wiring.test.ts` asserts that `scripts/check-tests-only.ts` is run by `.github/workflows/ci.yml` or `ci/ci.yml`, and that `scripts/flake-report.ts` is run by `.github/workflows/flakes.yml` or `ci/flakes.yml`, so the test keeps passing once the operator moves the staged files.

## Tests
- `tests/check-tests-only.test.ts`: [permanent] walks `tests/fixtures/tests-only/`: every `KINDS` entry has a fixture of that name and that fixture yields a finding of that kind; every fixture except `clean.diff` fails `problems` with no reason and passes with `Test change reason: renamed a helper, no assertion lost`; `clean.diff` yields no finding; a rewritten assertion (one removed, one added) is not a `removed-assertion`; a reason shorter than 10 characters is refused; `isTestFile` cases for each listed suffix and a `src/` path.
- `tests/quarantine.test.ts`: [permanent] the real ledger and the real `tests/` tree give no problems today; inline cases for a tagged test with no entry, a stale entry, a missing owner, an expiry past `MAX_DAYS`, and an expired entry, each giving its sentence; the `Makefile` `test` recipe's `-t` pattern, compiled as a RegExp, rejects a name containing `QUARANTINE_TAG` and accepts a plain one, and the `quarantine` recipe greps for `QUARANTINE_TAG`.
- `tests/flake-report.test.ts`: [permanent] `parseJunit` of `rerun.xml` counts 3 passes for the steady test and mixed results for the flipping one, and ignores the skipped one; `flakesIn` returns only the flipping test; `record` on `history.json` lifts it to `FLAKE_LIMIT` and `mustQuarantine` names it; a key at the limit that did not run is not named.
- `tests/ci-wiring.test.ts`: [permanent] both scripts are wired into a workflow, staged or live.

## Mutation
```json
{"name":"tests-only: removed assertion unseen","file":"scripts/check-tests-only.ts","find":"const ASSERTION = /\\b(?:expect|assert)\\s*\\(|\\bassert\\.\\w+\\s*\\(/;","replace":"const ASSERTION = /(?!)/;","test":"tests/check-tests-only.test.ts"}
```
```json
{"name":"tests-only: tests-only diff unseen","file":"scripts/check-tests-only.ts","find":"files.every((f) => isTestFile(f.path))","replace":"false","test":"tests/check-tests-only.test.ts"}
```
```json
{"name":"quarantine: expired entry passes","file":"scripts/quarantine.ts","find":"if (entry.expires < today) out.push(","replace":"if (false) out.push(","test":"tests/quarantine.test.ts"}
```
```json
{"name":"quarantine: make test runs tagged tests","file":"Makefile","find":"bun test -t '^(?!.*@quarantine)'","replace":"bun test -t '^(?!.*@quarantined)'","test":"tests/quarantine.test.ts"}
```
```json
{"name":"flakes: a flip is not a flake","file":"scripts/flake-report.ts","find":"runs.pass > 0 && runs.fail > 0","replace":"false","test":"tests/flake-report.test.ts"}
```

## Acceptance
- AC-1: a tests-only diff, a deleted test, a removed assertion, a new skip and a loosened matcher each fail the check without a stated reason, each has a fixture, and a clean diff passes: checked by `tests/check-tests-only.test.ts` (T1)
- AC-2: every quarantined test has an owner and an unexpired entry of at most 30 days, enforced against the real tree: checked by `tests/quarantine.test.ts` (T2)
- AC-3: a test that passes and fails in one rerun report is recorded, and one at the flake limit must be quarantined: checked by `tests/flake-report.test.ts` (T3)
- AC-4: the tests-only check and the nightly flake report are wired into a workflow: checked by `tests/ci-wiring.test.ts` (T4)

## Non-goals
- NG-1: no edit to `.github/workflows/`; the build stages `ci/ci.yml` and `ci/flakes.yml` and the operator moves them, then deletes `ci/`.
- NG-2: no change to `template/`, `template-ci/` or the gates a target repo runs; this is the factory's own suite only.
- NG-3: the factory's PR writer does not emit `Test change reason:` yet; a factory PR that trips the check is fixed by hand until a follow-up issue teaches it.
- NG-4: no decay of flake counts and no automatic tagging or issue filing; the nightly run fails and names the test, and a human tags it.
- NG-5: no change to the CTRF step; its flaky-rate table stays as the per-push view.
- NG-6: no new dependency.

## Files
- `scripts/check-tests-only.ts` (new)
- `tests/check-tests-only.test.ts` (new)
- `tests/fixtures/tests-only/only-tests.diff` (new)
- `tests/fixtures/tests-only/deleted-test.diff` (new)
- `tests/fixtures/tests-only/removed-assertion.diff` (new)
- `tests/fixtures/tests-only/new-skip.diff` (new)
- `tests/fixtures/tests-only/loose-matcher.diff` (new)
- `tests/fixtures/tests-only/clean.diff` (new)
- `scripts/quarantine.ts` (new)
- `tests/quarantine.json` (new)
- `tests/quarantine.test.ts` (new)
- `scripts/flake-report.ts` (new)
- `tests/flake-report.test.ts` (new)
- `tests/fixtures/flakes/rerun.xml` (new)
- `tests/fixtures/flakes/history.json` (new)
- `ci/ci.yml` (new)
- `ci/flakes.yml` (new)
- `tests/ci-wiring.test.ts` (new)
- `Makefile` (edit: `TEST_ARGS` and the flake rule comment)
- `CONTRIBUTING.md` (edit: two paragraphs)
- `tests/mutations.json` (edit: add the five entries)
