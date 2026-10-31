<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
PR #374 (branch feat/q-hooks) adds a sign-off hook and cheap pre-push checks, but CI and the audit fail for two reasons. First, it edits `.githooks/pre-push`, and `scripts/kaas/check-repo.py` (`hook_errors`) requires that file to equal the kit stub byte for byte, so `check-affected.py --audit` fails; extra push steps belong in the `prePush` list of the repo's `repo.json`. Second, its Makefile edit moved the text that the mutation "release: teaching material stays out" anchors on, so `make check-mutations` fails with "find matches 0 times in Makefile". Issue #346.

## Today
- Branch `feat/q-hooks` already holds `.githooks/commit-msg`, `scripts/install-hooks.ts`, `tests/hooks.test.ts`, a Makefile `hooks` target and a `hooks: never sign off` mutation. Work on that branch, not on main.
- `.githooks/pre-push` on that branch runs `bun scripts/dco.ts` and `bun x biome ci .` before the kit gate; on main it is the kit stub.

## Change
### T1: restore the stub and move the checks
Files: `.githooks/pre-push`, `.agents/repo.json`, `tests/hooks.test.ts`
Model: sonnet
1. `git fetch origin feat/q-hooks main && git checkout -b feat/q-hooks-fix origin/feat/q-hooks`. Make `.githooks/pre-push` byte-identical to its content on `origin/main` (`git show origin/main:.githooks/pre-push`).
2. Find where `scripts/kaas/check-repo.py` and `scripts/kaas/pre-push.sh` read the `prePush` list (read both first) and add the two commands, `bun scripts/dco.ts` and `bun x biome ci .`, to that list in the repo's repo.json (the file the kit reads; `.agents/repo.json` if that is where the other keys live).
3. In `tests/hooks.test.ts`, replace the "script text calls both commands" test with one that reads the repo.json `prePush` list and asserts it contains both commands; keep the temp-repo test that an unsigned commit is refused.

### T2: put the Makefile edit back where the anchor expects it
Files: `Makefile`
Model: sonnet
Deps: T1
1. Run `bun scripts/check-mutation-anchors.ts` (it exists on main) and `make check-mutations` until neither reports "matches 0 times". The `hooks` target must sit where it does not alter the text that other mutation `find` strings match; move it, do not edit other entries.

## Tests
- `tests/hooks.test.ts`: [permanent] the commit-msg cases, the prePush list case and the unsigned-push refusal.

## Mutation
Keep the existing `hooks: never sign off` entry from the branch; it must still match once.

## Acceptance
- AC-1: `.githooks/pre-push` equals main's stub and the audit passes: checked by `python3.12 scripts/kaas/check-affected.py --audit` (T1)
- AC-2: the prePush list holds the dco and biome commands: checked by `make test FILES=tests/hooks.test.ts` (T1)
- AC-3: every mutation anchor matches once: checked by `bun scripts/check-mutation-anchors.ts` (T2)

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `.githooks/pre-push`
- `.agents/repo.json`
- `tests/hooks.test.ts`
- `Makefile`

## How to ship
Push to branch feat/q-hooks (a fast-forward commit on top of the existing one, so PR #374 updates), not a new branch: use `git checkout -B feat/q-hooks origin/feat/q-hooks` instead of a new branch name. Commits use `git commit -s`. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Never put a session link in a commit or PR.
