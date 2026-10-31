<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
A PR body that fails the template check is found only after CI runs, and editing the body does not re-run CI, so the fix needs a close and reopen. Issue #385.

## Today
- `scripts/check-pr-body.ts` exports `problems(body, template)` and reads the body from `PR_BODY` only under `import.meta.main`.
- `src/engine/pr-body.ts` builds the factory PR body (`prBody`); read it and the step that opens the PR (grep for `prBody(`) before you edit.
- `ci/ci.yml` is the staged copy of the CI workflow; the sandbox token cannot push `.github/workflows`.

## Change
### T1: lint a body file locally
Files: `scripts/check-pr-body.ts`, `tests/check-pr-body.test.ts`
Model: sonnet
1. Add a `--file <path>` argument to the `import.meta.main` block: it reads the body from that file instead of `PR_BODY`, prints the same messages and exits 1 on any problem. Keep the `PR_BODY` path working.
2. Tests: a temp body file with `Verify verdict: Pending CI` exits 1 with the placeholder message; a complete body exits 0; `PR_BODY` still works. Run the script as a child process with `Bun.spawnSync`.

### T2: refuse to open a failing PR
Files: `src/engine/pr-body.ts`, `tests/pr-body-lint.test.ts`
Model: sonnet
Deps: T1
1. Before the step opens a PR, call `problems(body, template)` on the rendered human-shaped body. On a problem, do not open the PR: fail the step with the problem list in the message. A factory-shaped body stays exempt, as `problems` already decides.
2. Test with a fixture body that has a placeholder verdict: the open call is never made and the error names the section.

### T3: re-run the check when the body is edited
Files: `ci/ci.yml`
Model: haiku
Deps: T1
1. In the staged workflow, add `edited` to the `pull_request` types of the job that runs `bun scripts/check-pr-body.ts`, so an edit re-runs it. State in the PR body that a person moves `ci/ci.yml` to `.github/workflows/ci.yml`.

## Tests
- `tests/check-pr-body.test.ts`: [permanent] the file-argument cases.
- `tests/pr-body-lint.test.ts`: [permanent] the refusal before open.

## Mutation
```json
{"name":"pr-lint: open a PR with a placeholder verdict","file":"src/engine/pr-body.ts","find":"problems(","replace":"[].concat(","test":"tests/pr-body-lint.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file as you wrote it.

## Acceptance
- AC-1: `--file` with a placeholder verdict exits 1 with the CI message: checked by `make test FILES=tests/check-pr-body.test.ts` (T1)
- AC-2: a failing body never reaches the open call: checked by `make test FILES=tests/pr-body-lint.test.ts` (T2)
- AC-3: the staged workflow lists `edited` for the body check: checked by `make test FILES=tests/ci-wiring.test.ts` (T3)

## Non-goals
Do not touch .github/workflows (stage workflow edits under ci/). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `scripts/check-pr-body.ts`
- `tests/check-pr-body.test.ts`
- `src/engine/pr-body.ts`
- `tests/pr-body-lint.test.ts`
- `ci/ci.yml`
- `tests/ci-wiring.test.ts`

## How to ship
One PR from branch feat/s-pr-lint. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry is {name,file,find,replace,test}; its `find` matches exactly once and the test must fail under the replacement. Put new mutations in a shard file `tests/mutations/s-pr-lint.json`, never in tests/mutations.json. Never put a session link in a commit or PR.
