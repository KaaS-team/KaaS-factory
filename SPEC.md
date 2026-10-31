<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
A stale `find` anchor in `tests/mutations.json` (the `src/cli.ts` line count) broke four PRs (#278, #279, #336, #341) and was only found by the 10 minute mutation job. Issue #344.

## Today
- `tests/mutations.json` is a JSON array of `{name,file,find,replace,test}`. `scripts/check-mutations.ts` applies each entry and runs its test, which is slow.
- Nothing checks cheaply that each `find` still matches its file exactly once.
- `make check` is `lint typecheck test skills-check` (Makefile line 9); the required CI job `push` runs `make check`.

## Change
### T1: anchor checker
Files: `scripts/check-mutation-anchors.ts`, `tests/check-mutation-anchors.test.ts`
Model: sonnet
1. `scripts/check-mutation-anchors.ts` exports `anchorProblems(entries, read)` where `read(file)` returns the file text or undefined. It returns one string per entry whose file is missing, whose `find` is empty, or whose `find` occurs a number of times other than 1 (count with `split(find).length - 1`). Each string names the entry and the count.
2. Its `import.meta.main` block reads `tests/mutations.json`, calls `anchorProblems` with `readFileSync`, prints `check-mutation-anchors: ok (N entries)` or the problems to stderr, and exits 1 on any problem. It must run in under 2 seconds.
3. `tests/check-mutation-anchors.test.ts`: a unit test on `anchorProblems` with an in-memory file map (zero matches, two matches, missing file, one match), plus one test that runs the real file list and expects no problems.

### T2: wire it into make check
Files: `Makefile`, `tests/mutations.json`
Model: sonnet
Deps: T1
1. Add a Make target `check-anchors` that runs `bun scripts/check-mutation-anchors.ts` and add it to the `check` prerequisites.
2. Run the checker. For every entry it reports, fix the `find` (and `replace` if it embeds the same text) so it matches once, keeping the mutation's meaning. Do not delete entries. Do not rewrite the file with a JSON serialiser; edit the lines in place so the diff is only the changed entries.
3. Add the Mutation entries below.

## Tests
- `tests/check-mutation-anchors.test.ts`: [permanent] the unit cases above and the real-file case.
- `tests/ci-wiring.test.ts`: [permanent] existing; extend it with one assertion that the `check` target lists `check-anchors`.

## Mutation
```json
{"name":"anchors: accept zero matches","file":"scripts/check-mutation-anchors.ts","find":"!== 1","replace":"< 0","test":"tests/check-mutation-anchors.test.ts"}
```
```json
{"name":"anchors: skip missing file","file":"scripts/check-mutation-anchors.ts","find":"if (text === undefined)","replace":"if (false)","test":"tests/check-mutation-anchors.test.ts"}
```
Adjust each `find` to the exact text you wrote so it matches once.

## Acceptance
- AC-1: `bun scripts/check-mutation-anchors.ts` prints `ok` on the tree and exits 0: checked by `make test FILES=tests/check-mutation-anchors.test.ts` (T1)
- AC-2: a `find` that is absent makes the checker exit 1 and name the entry: checked by `make test FILES=tests/check-mutation-anchors.test.ts` (T1)
- AC-3: `make check` runs the anchor check: checked by `make test FILES=tests/ci-wiring.test.ts` (T2)

## Non-goals
Do not touch .github/workflows (stage any CI change under ci/ and say so in the PR). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `scripts/check-mutation-anchors.ts`
- `tests/check-mutation-anchors.test.ts`
- `tests/ci-wiring.test.ts`
- `Makefile`
- `tests/mutations.json`

## How to ship
One PR from branch feat/q-anchors. Commits use `git commit -s`. PR body uses every section of .github/pull_request_template.md, filled with real evidence (the gate output, not "pending"). Run `python3 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry in tests/mutations.json is {name,file,find,replace,test}; its `find` must match exactly once in its file, and the test must fail under the replacement. Never put a session link in a commit or PR.
