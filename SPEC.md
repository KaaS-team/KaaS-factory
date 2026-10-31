<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
A missing sign-off forced PR #278 to be resubmitted as #279, and format and wording failures surfaced only in CI. Issue #346.

## Today
- `.githooks/pre-push` exists (read it first). There is no `commit-msg` hook and no command that installs hooks.
- `scripts/dco.ts` checks sign-offs in CI.

## Change
### T1: commit-msg hook
Files: `.githooks/commit-msg`, `tests/hooks.test.ts`
Model: sonnet
1. `.githooks/commit-msg` is an executable POSIX sh script. If the message file has no `Signed-off-by:` line it appends one using `git var GIT_AUTHOR_IDENT` name and email (blank line first). It never adds a second one. It must not add any `Claude-Session` or link text.
2. `tests/hooks.test.ts` creates a temp git repo, sets `core.hooksPath` to the repo's `.githooks` directory, commits with no `-s`, and asserts the commit message ends with exactly one `Signed-off-by:` line; it commits again with `-s` and asserts there is still exactly one.

### T2: pre-push runs the cheap checks
Files: `.githooks/pre-push`, `tests/hooks.test.ts`
Model: sonnet
Deps: T1
1. Extend `.githooks/pre-push` to run `bun scripts/dco.ts` against the commits being pushed and `bun x biome ci .` (both fast). Keep whatever it already does. A failure blocks the push with the failing command printed.
2. Test: the script text calls both commands (read the file, assert the strings), and a temp-repo push of an unsigned commit is refused when the hook runs.

### T3: install command
Files: `scripts/install-hooks.ts`, `Makefile`, `tests/hooks.test.ts`
Model: sonnet
1. `scripts/install-hooks.ts` runs `git config core.hooksPath .githooks` and prints one line saying so. It is idempotent.
2. Add the Make target `hooks` that runs it. Add a test that runs the script in a temp git repo and reads `core.hooksPath` back.

## Tests
- `tests/hooks.test.ts`: [permanent] the cases above.

## Mutation
```json
{"name":"hooks: never sign off","file":".githooks/commit-msg","find":"Signed-off-by:","replace":"Signed-off-by-x:","test":"tests/hooks.test.ts"}
```
Adjust `find` to text that occurs exactly once in the script you wrote.

## Acceptance
- After `make hooks`, `git commit -m x` in the repo yields a commit with one `Signed-off-by:` line.
- An unsigned commit cannot be pushed.
- `make hooks` run twice changes nothing.

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
`.githooks/commit-msg`, `.githooks/pre-push`, `scripts/install-hooks.ts`, `tests/hooks.test.ts`, `Makefile`, `tests/mutations.json`

## How to ship
One PR from branch feat/q-hooks. Commits use `git commit -s`. PR body uses every section of .github/pull_request_template.md, filled with real evidence (the gate output, not "pending"). Run `python3 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry in tests/mutations.json is {name,file,find,replace,test}; its `find` must match exactly once in its file, and the test must fail under the replacement. Never put a session link in a commit or PR.
