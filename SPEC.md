<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
Sessions launched at the same time edit the same files, so their PRs conflict when the second one merges. Every spec already lists its `## Files`. A planner that launches only specs whose file sets do not overlap each other or any open PR avoids the conflict before it exists, with no model. Issue #392 and the area-lock item in the epic E2 notes.

## Today
- A spec ends with a `## Files` section: one backtick-quoted path per bullet (`- \`src/a.ts\``). The ready specs sit in a folder as `*.md`. Open PRs and their changed files come from `gh pr list --json number,files`; the planner takes that as a JSON file so tests need no network.
- Read `scripts/lint-planned.ts` first to see how it reads a spec, and reuse its section parsing if it exports one.

## Change
### T1: pure planner
Files: `src/batch-plan.ts`, `tests/batch-plan.test.ts`
Model: sonnet
1. `src/batch-plan.ts` exports `specFiles(markdown): string[]`, the paths in the `## Files` section (empty list when absent).
2. It exports `overlaps(a: string[], b: string[]): boolean`: true when any path is equal, or one is a directory prefix of the other (`src/engine` and `src/engine/steps.ts`), or the same shard folder is shared. Exact paths are compared after trimming a leading `./`.
3. It exports `planBatch(specs: {name: string; files: string[]; deps?: string[]}[], busy: string[][], limit: number, done: string[] = [])`. It walks specs in the given order and picks a spec only if: all its `deps` are in `done`, its files overlap no path in `busy` (the files of open PRs), and they overlap no spec already picked. It stops at `limit` and returns `{ picked: string[]; skipped: {name: string; reason: "deps" | "busy" | "overlap"}[] }`.
4. Tests: two disjoint specs are both picked; two that share a file pick the first and skip the second with reason overlap; a spec overlapping an open PR is skipped with reason busy; a spec whose dep is not done is skipped with reason deps and picked once the dep is in `done`; the limit is respected; `src/engine` versus `src/engine/steps.ts` counts as overlap; `specFiles` reads a real section and returns empty without one.

### T2: CLI
Files: `scripts/plan-batch.ts`, `tests/plan-batch.test.ts`
Model: sonnet
Deps: T1
1. `bun scripts/plan-batch.ts --specs <dir> --prs <prs.json> --limit <n> [--done a,b]` prints one picked spec name per line, then `skipped: <name> <reason>` lines on stderr. The prs file is the `gh pr list --json number,files` shape; `files` is a list of `{path}`.
2. Test with a temp dir of three spec files and a prs.json: the printed names match the expected pick, and a missing `--specs` directory exits 1 with a message.

## Tests
- `tests/batch-plan.test.ts`: [permanent] the planner cases.
- `tests/plan-batch.test.ts`: [permanent] the CLI cases.

## Mutation
```json
{"name":"batch-plan: ignore open pull request files","file":"src/batch-plan.ts","find":"busy.some(","replace":"false && busy.some(","test":"tests/batch-plan.test.ts"}
```
Adjust `find` to text that occurs exactly once in your file, and make sure the test goes red under it. Save it to `tests/mutations/batch-plan-ignore-open-pull-request-files.json` (a single JSON object).

## Acceptance
- AC-1: overlapping specs never launch together: checked by `make test FILES=tests/batch-plan.test.ts` (T1)
- AC-2: a spec that touches a file an open PR touches is held back: checked by `make test FILES=tests/batch-plan.test.ts` (T1)
- AC-3: a spec waits for its deps: checked by `make test FILES=tests/batch-plan.test.ts` (T1)
- AC-4: the CLI prints the picked names and exits 1 on a missing directory: checked by `make test FILES=tests/plan-batch.test.ts` (T2)

## Non-goals
The planner launches nothing and calls no API; it only prints a pick. Do not wire it into `make check` or CI. Do not touch `.github/workflows`. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `src/batch-plan.ts`
- `tests/batch-plan.test.ts`
- `scripts/plan-batch.ts`
- `tests/plan-batch.test.ts`
- `tests/mutations/batch-plan-ignore-open-pull-request-files.json`

## How to ship
One PR from branch feat/b4-batch-planner. Commits use `git commit -s`. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. The mutation goes in the shard file named above, never in tests/mutations.json; do not edit tests/mutation-list.test.ts. Never put a session link in a commit or PR.
