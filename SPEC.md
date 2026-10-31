<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
Parallel PRs all append to the same lines: the Makefile `.PHONY` line and the `check:` prerequisites, and new tests at the end of `tests/ci-wiring.test.ts`. Every merge to main makes the next PR conflict there (seen on #403 to #405). The fix is to give each feature its own file that is collected at run time, so two PRs never touch the same line. Issue #384 and the merge strategy in the epic E2 notes.

## Today
- `Makefile` line 1 is one `.PHONY:` line; `check:` lists its prerequisites on one line (`lint typecheck test skills-check check-anchors check-baseline`).
- `tests/ci-wiring.test.ts` holds one hand-written `test(...)` per wired script, plus two tests that read the `check:` line of the Makefile with a regex.
- Read `Makefile`, `tests/ci-wiring.test.ts` and `scripts/check-mutation-anchors.ts` first. Mutations in `tests/mutations/*.json` anchor on exact Makefile text, so do not move or reword existing Makefile lines other than the two named below.

## Change
### T1: Makefile includes per-feature files
Files: `Makefile`, `make/README.md`, `tests/make-registry.test.ts`
Model: sonnet
1. In `Makefile`, directly after the first `.PHONY:` line add `include $(wildcard make/*.mk)` and change the `check:` line to `check: lint typecheck test skills-check check-anchors check-baseline $(CHECK_EXTRA)`. Nothing else in the Makefile changes.
2. Create `make/README.md` (under 15 lines): a feature adds `make/<feature>.mk` that declares `.PHONY: <target>`, the target itself, and `CHECK_EXTRA += <target>` when it belongs in `make check`; it never edits the Makefile.
3. `tests/make-registry.test.ts`, using a temp directory (copy `Makefile` into it; no other repo files needed because `make -pn` only reads the rules): (a) with a fixture `make/probe.mk` holding `.PHONY: check-probe`, `CHECK_EXTRA += check-probe` and a `check-probe:` rule, the output of `make -pn check` has a line starting `check:` whose words include `check-probe`, `check-anchors` and `check-baseline`; (b) with no `make/` directory the same command still works and lists `check-baseline`; (c) structural: for every real `make/*.mk` in the repo, each `check-*` target it defines is listed in its own `.PHONY` and `CHECK_EXTRA` lines (passes vacuously while the folder is empty).
4. Replace the two `ci-wiring` tests that regex the `check:` line (in T2) with the `make -pn` approach from (a), so they read the real prerequisites.

### T2: ci-wiring becomes a table
Files: `tests/ci-wiring.test.ts`, `tests/ci-wiring/check-changed-mutants.json`, `tests/ci-wiring/check-tests-only.json`, `tests/ci-wiring/flake-report.json`
Model: sonnet
Deps: T1
1. Each existing script test becomes one JSON file in `tests/ci-wiring/`, shape `{"script":"scripts/x.ts","workflows":[".github/workflows/a.yml","ci/a.yml"]}` (`check-changed-mutants` lists two scripts: use `"scripts":[...]` in that file, and let the loader accept `script` or `scripts`).
2. `tests/ci-wiring.test.ts` keeps its `runs()` helper and loops over `tests/ci-wiring/*.json`, one `test(...)` per script, so adding a wired script is adding a file. A table file with no `workflows` entry, or listing a workflow that does not exist, fails the test.
3. The two `make check` tests read `make -pn check` as in T1.4.

## Tests
- `tests/make-registry.test.ts`: [permanent] cases (a) to (c).
- `tests/ci-wiring.test.ts`: [permanent] one test per table file, the empty-entry failure, and the two `check:` assertions.

## Mutation
```json
{"name":"ci-wiring: any workflow text passes","file":"tests/ci-wiring.test.ts","find":".includes(`bun ${script}`)","replace":".includes(\"\") || true","test":"tests/ci-wiring.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file after your edit, and make sure the test goes red under it (add a table file with a script no workflow runs, in a temp copy, if needed). Save it to `tests/mutations/ci-wiring-any-workflow-text-passes.json`.

## Acceptance
- AC-1: a `make/*.mk` file with `CHECK_EXTRA += x` adds `x` to the `check` prerequisites without touching the Makefile: checked by `make test FILES=tests/make-registry.test.ts` (T1)
- AC-2: a `check-*` target missing from `.PHONY` or `CHECK_EXTRA` in its `.mk` file fails the structural test: checked by `make test FILES=tests/make-registry.test.ts` (T1)
- AC-3: every wired script is asserted from its own table file and a bad entry fails: checked by `make test FILES=tests/ci-wiring.test.ts` (T2)
- AC-4: `make check` still lists `check-baseline` and `check-anchors`: checked by `make test FILES=tests/ci-wiring.test.ts` (T2)

## Non-goals
Do not touch `.github/workflows` or `ci/`. Do not move `check-baseline` or any other existing target out of the Makefile. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `Makefile`
- `make/README.md`
- `tests/make-registry.test.ts`
- `tests/ci-wiring.test.ts`
- `tests/ci-wiring/check-changed-mutants.json`
- `tests/ci-wiring/check-tests-only.json`
- `tests/ci-wiring/flake-report.json`
- `tests/mutations/ci-wiring-any-workflow-text-passes.json`

## How to ship
One PR from branch feat/b1-registry-shards. Commits use `git commit -s`. Run `bun scripts/check-mutation-anchors.ts` after the Makefile edit; it must still pass. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. The mutation goes in the shard file named above (a single JSON object), never in tests/mutations.json; do not edit tests/mutation-list.test.ts. Never put a session link in a commit or PR.
