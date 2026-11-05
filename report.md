BRANCH: cluster/v7.0-registry-cli
HEAD: 341bd44cb420fd3b0b982e4c5e801f20a76391e9
## Summary
`factory watch --all` now polls every enabled repo in machine.json "repos" in one process through pollRegistry (new src/registry-cli.ts). A test runs that entry against a fake registry of two repos and dispatches one issue from each.
## Issues
- #604: done.
  - One watcher polls every registered repo within the lease and cost caps -> tests/repo-registry.test.ts "the CLI entry polls both repos of a fake registry and dispatches one issue from each" (caps are held by pollRegistry/pollOnce from PR #660) -> tests/mutations/watch-all-builds-sources-for-the-first-repo-only.json, watch-all-ignores-the-registry-and-needs-a-repo-dir.json
  - Fake registry with two repos dispatches one issue from each -> same test -> same mutations. Also "factory watch --all with no registry refuses instead of watching nothing" -> watch-all-polls-an-empty-registry-without-refusing.json
- #198: done for its one line. #603 (registry) shipped earlier; #604 is done above. Nothing else recorded as open.
## Staged workflow changes
none
## Checkpoints
#604 and #198: 1 to 7 all yes. src/cli.ts line count unchanged (903). No cap or baseline moved.
## Files outside my area
src/cli.ts (one dispatch line), src/help.ts and docs/cli-reference.md (usage text for --all, regenerated).
## Gate evidence
make fast: ok (13 mutations bite). Test file x3: 24 pass. Full make test: 4291 pass, 1 fail: tests/lean-resources.test.ts under load, passes alone and on the base.
## Risk and rollback
Opt-in via --all; existing watch paths untouched. Revert the commit. Limits: one loop sleeps the shortest pollIntervalSeconds of the served repos (default 60), not each repo's own cadence; no webhook wakeups or tmux in --all mode.
## Learnings
- tests/lean-resources.test.ts fails under full-suite load; rerun alone.
- A first make fast run failed once in the test-only check and passed on rerun; I did not find the cause.
- cli.ts has a typed ctx object (cli) for cli-runtime; harnessCtx lacks resolveCloneDir.
