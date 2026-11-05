BRANCH: cluster/v6.4-baseline-split
HEAD: 2de31106e8afbecdc6098994e79b791e8b859c2b
## Summary
All three acceptance lines of #168 already hold on release/v6.4.0, so I changed no code. The branch is the base commit, pushed unchanged.
## Issues
- #168: already held.
  - Baseline split so two PRs that each add an entry merge cleanly: `quality-baseline/<metric>/<slug>.json` holds 139 one-entry files (`src/baseline-shards.ts`); `quality-baseline.json` is only the `exclude` marker. Test: "two branches that each add a baseline entry merge with no conflict" (tests/baseline-shards.test.ts). Mutation: tests/mutations/baseline-each-entry-is-its-own-file.json, caught.
  - `factory hotspots` lists the files most often changed by parallel PRs: `src/hotspots.ts`, `src/hotspots-cli.ts`; `bin/factory hotspots` printed "59 merged PRs read" and a ranked list. Test: "factory hotspots lists the files several merged PRs changed". Mutations: hotspots-a-file-one-pr-changed-is-not-a-hotspot.json and hotspots-a-commit-with-no-pr-number-is-not-a-pr.json, both caught.
  - Test merges two branches that each add a baseline entry with no conflict: same merge test as above (real git init, merge exit 0, no CONFLICT).
  - `bun test tests/baseline-shards.test.ts`: 7 pass, 0 fail.
  - I did not revert the fix, because no fix was written. The mutation runs show each test goes red when its behaviour is removed.
## Staged workflow changes
none
## Checkpoints
#168: 1 to 7 all yes (no diff against base).
## Files outside my area
none
## Gate evidence
make fast: ok
## Risk and rollback
No risk: no change. Delete the branch to roll back.
## Learnings
- The brief's premise ("quality baseline is still one file") was out of date for v6.4.0. Check the base for shards and a hotspots command before assigning the issue.
- I did not run `--rerun-each 3` or the full `make test`, because no test or code changed.
