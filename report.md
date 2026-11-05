BRANCH: cluster/v7.1-codebase-fit
HEAD: 15128b8c2d287418909dd87d7a4cf7389924eaa0
## Summary
#222 is done in one commit. A new `src/conventions.ts` derives a profile (formatter, linter, type checker, style facts, test layout) that the build and verify context packs carry, and `ShellGateRunner` runs the detected tools and folds a format diff into the `FACTORY_GATES` line as RED.
## Issues
- #222: done.
  - Profile given to build and verify -> `tests/conventions.test.ts` "context pack > build receives the conventions profile" and "verify receives..." (plan gets none) -> `build-gets-no-conventions-profile.json`, `verify-gets-no-conventions-profile.json`; detection and style facts -> "detectConventions" tests -> `a-tab-indent-style-is-not-reported.json`.
  - Own formatter, linter, type checker detected and run, format diff fails the gate -> "format-diff gate > a format diff turns a green run red and names the gate", "a clean format check stays green", "a tool that is not installed does not fail the build", "a repo whose config already has a format gate is not checked twice" -> `a-format-diff-does-not-fail-the-gate.json`, `a-configured-format-gate-is-run-twice.json`.
  - Non-default style repo gets a change that follows it -> "a repo with a non-default style, checked by its own formatter" (real biome with tab and single-quote config: tab-style change passes, default-style change is RED on `format`); the profile text for a tabs/single-quote/no-semicolon Prettier repo is asserted in "states a non-default style and the test layout".
## Staged workflow changes
none
## Checkpoints
#222: 1 to 7 all yes. `src/context.ts` is the build and verify prompt input, so in area. No pins raised. Neighbour tests (gates, context-pack, review-md, token-budget, agent-dirs, skills-dir, gate-scope, install) pass.
## Files outside my area
none
## Gate evidence
make fast: ok
## Risk and rollback
Risk: a repo whose lint or type check already fails, with no gate of that role in `.factory/config.json`, now goes RED on it. The format check is limited to changed files, so old style problems do not fail a change. A missing tool (exit 127, or no `node_modules/.bin` binary) is skipped. Lint and type check run only when the config has no gate of that role and are not scoped to the diff. Rollback: revert the commit.
## Learnings
- Full `make test` run once had `tests/provenance.test.ts` hit ENOENT walking `tests/.tmp-cloud-build/` while another parallel test removed a temp dir (an "Unhandled error between tests" block). It passes alone; it is a flake from the walk. The walk should skip `tests/.tmp-*`.
- `make fast` rejects `describe.skipIf` as a new skip; the brief should mention it.
- Bun here is 1.4.4, not the 1.3 the brief names.
