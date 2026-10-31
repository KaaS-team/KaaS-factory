<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
`quality-baseline.json` pins line counts by hand. Every PR that touches a pinned file edits it, and the stale `src/cli.ts` count broke four PRs. Issue #347.

## Today
- `quality-baseline.json` maps a file to its frozen size; `tests/quality.test.ts` fails when a file grows past its entry or an entry is above the file's real size. Read both first to learn the exact JSON shape; keep it unchanged.

## Change
### T1: generator
Files: `scripts/gen-quality-baseline.ts`, `tests/gen-quality-baseline.test.ts`
Model: sonnet
1. `scripts/gen-quality-baseline.ts` exports `regenerate(current, measure, allowRaise)`: for each entry in the current baseline it measures the file; an entry may only go down (or stay) unless `allowRaise` is true; a deleted file drops its entry. It returns the new object and the list of entries that would have risen.
2. The `import.meta.main` block: with no flag it writes the lowered baseline in place, preserving the file's key order and 2-space JSON formatting. With `--check` it writes nothing, prints each stale entry, and exits 1 if the file on disk differs from the result. With `--allow-raise` raises are written.
3. Tests: lowers a shrunk file, keeps an unchanged one, refuses a raise (reported, not written), allows it with the flag, drops a deleted file, and `--check` exits 1 on a stale baseline in a temp copy.

### T2: wire the check
Files: `Makefile`, `tests/ci-wiring.test.ts`
Model: sonnet
Deps: T1
1. Add the Make target `check-baseline` running `bun scripts/gen-quality-baseline.ts --check`, and add it to the `check` prerequisites. If the check fails on the tree today, run the generator once and commit the lowered file.
2. Extend `tests/ci-wiring.test.ts` with one assertion that `check` lists `check-baseline`.

## Tests
- `tests/gen-quality-baseline.test.ts`: [permanent] the cases above.

## Mutation
```json
{"name":"baseline: allow raise without flag","file":"scripts/gen-quality-baseline.ts","find":"allowRaise &&","replace":"true ||","test":"tests/gen-quality-baseline.test.ts"}
```
Adjust `find` to text that occurs exactly once in your script.

## Acceptance
- AC-1: a stale baseline fails the check with the stale entries named: checked by `make test FILES=tests/gen-quality-baseline.test.ts` (T1)
- AC-2: growing a file past its entry is never fixed silently: checked by `make test FILES=tests/gen-quality-baseline.test.ts` (T1)
- AC-3: `make check` lists `check-baseline`: checked by `make test FILES=tests/ci-wiring.test.ts` (T2)

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `scripts/gen-quality-baseline.ts`
- `tests/gen-quality-baseline.test.ts`
- `tests/ci-wiring.test.ts`
- `Makefile`
- `quality-baseline.json`
- `tests/mutations.json`

## How to ship
One PR from branch feat/q-baseline. Commits use `git commit -s`. PR body uses every section of .github/pull_request_template.md, filled with real evidence (the gate output, not "pending"). Run `python3 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry in tests/mutations.json is {name,file,find,replace,test}; its `find` must match exactly once in its file, and the test must fail under the replacement. Never put a session link in a commit or PR.
