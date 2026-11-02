# KaaS-factory CI speed research (read-only, 1 Nov 2026)

Data: `gh` on KaaS-team/KaaS-factory, last 200 runs per workflow (30 Oct 18:45Z to 1 Nov 05:57Z), per-step timings of the last 30 finished PR runs of ci.yml, ctrf report of run 41278859795, repo clone in the scratchpad `sp`.

## 1. Measured

PR wall time (ci workflow, finished runs): median 130 s, p90 152 s. Push to main: median 138 s, p90 181 s.

| Job | Median | Max | On the critical path |
|---|---|---|---|
| push (the required check) | 130 s | 161 s | yes |
| docker-build | 78 s | 95 s | no (parallel, not required) |
| quarantine | 12 s | 20 s | no |
| mutations on a PR (own workflow) | 18 s | 41 s | no (already scoped with --base) |
| mutations on push to main | 328 s | 485 s | no |

Steps of the `push` job (median): checkout 2 s, setup-bun 2 s, tmux apt install 5 s (max 16), `make install` 0.3 s (16 packages), `make check` 104 s, security scan 4 s, ctrf reporter 5 s. DCO, PR body, check-tests-only and the 3x rerun are each under 2 s when they pass.

Inside `make check` (run 41278859795, timestamps): biome ci 1.4 s (729 files in 973 ms), reuse lint 1.9 s, rustfmt and clippy for verify and relay about 7 s, tsc 7 s, `bun test` 80 s (3417 tests, 15 skipped), skills-ref 4 s, anchors, baseline and cli-reference under 1 s. So lint plus typecheck is about 17 s of 104 s; tests are 77%.

Tests run serially: summed per-test duration is 70 s against 80 s wall. Slowest file is 6.1 s (tests/runtimes.test.ts), 307 test files, so no single file bounds a shard. Slowest single tests: 5.0 s (uvx), 4.8 s (docker egress), 3.1 s, 3.0 s (idle RSS).

Biome is not a bottleneck: 1 s. Swapping or adding oxlint saves at most about 1 s. Moot, do not do it.

Red rate on PRs (last 128 finished ci runs, 28 h): 34 failed, 91 passed, 3 cancelled = 27% red. First failing step of the 34:
- make check 12 (the 5 newest all Biome: `useTemplate` infos plus format diffs in tests/healer, plan-deps, secret-scan)
- weakening-test check (check-tests-only) 9
- 3x rerun of new tests 7
- PR body template 4
- security scan 2
- docker-build 2
Every one of these is a check an agent can run locally in under 30 s. None needs CI. The pre-push hook (biome ci and DCO) exists, but a cloud session that pushes without the hook or with SKIP_GATE sees none of it. `.agents/repo.json` has no `impact` map and ci.yml never calls check-affected.py, so neither CI nor `--stage push` is narrowed.

Why the CI log lacked `(fail)` lines: `make check` runs lint first and stops there, so tests never ran. Separately, when lint fails the ctrf reporter step (`if: always()`) fails too because reports/junit.xml is missing (4 of the 34 reds carry that second red step), which buries the real error.

## 2. Ranked changes

Minutes are per PR. "Red loop" = one failed CI run plus the agent turn that re-pushes (about 2 min CI plus agent time), 27% of PRs.

| # | Change | Saves per PR | Risk | Files | Verification |
|---|---|---|---|---|---|
| 1 | `make fast` (biome ci, check-tests-only, PR body lint, check-mutations --base, 3x rerun of changed tests, affected tests) wired into the cloud session rules and pre-push, and a bash script that does not need hooks | about 1.5 to 3 (removes about 27% red loops at about 2 min CI plus agent time each) | low | Makefile, scripts/kaas/pre-push.sh, .agents/repo.json prePush, AGENTS.md pointer, template-ci | Replay the 5 recent Biome reds and the 9 weakening-test reds: `make fast` must exit non-zero on each |
| 2 | Run tests with `bun test --parallel` (isolated workers) or split with `--shard=M/N` over 2 to 3 matrix jobs; keep one aggregate job named `push` for branch protection | about 0.7 to 1 (80 s to about 25 to 40 s; estimate) | medium: tests using tmux, docker, shared ports or the preload may collide | Makefile (`test` TEST_ARGS), ci.yml, tests/preload.ts | Same 3417 tests and same pass count in junit; run 5 times, zero new flakes; revert the shard flag and watch wall time return |
| 3 | Split `make check` into parallel CI jobs: lint+typecheck+skills (about 25 s) and tests, so one push shows every failure at once | about 1 per red PR that has two problems (removes the second red loop); wall unchanged when green | low | ci.yml (jobs), Makefile (targets already exist) | Push a branch with a lint error and a failing test: both appear in one run, with `(fail)` lines |
| 4 | Guard the ctrf step: `if: always() && hashFiles('reports/junit.xml') != ''`; print failing test names with a `bun test` dots reporter in the log | 5 s plus clearer logs | low | ci.yml | A lint-red run shows one failed step only |
| 5 | Merge queue (`merge_group` trigger on ci and mutations) instead of serial merge plus re-run on main | about 1 to 2 when PRs overlap (30 of 72 main-push ci runs were cancelled, the rest re-run 138 s ci plus 328 s mutations) | medium: queue latency adds one CI per PR; needs branch protection admin | ci.yml, mutations.yml, repo settings | Merge 3 PRs at once: each lands once, main push run count falls |
| 6 | Impact map (`eng-impact-map` skill) so `check-affected.py --run --base origin/main` is what agents run locally, and CI keeps the full gate | feeds #1; local only, about 1 min per local gate | low | .agents/repo.json | `check-affected.py --audit` passes; a docs-only change plans zero test files |
| 7 | docker-build only on paths that feed the image (Dockerfile, docker-compose.yml, docker-entrypoint.sh, src/deploy/**, relay/**, verify/**, package.json, bun.lock) plus nightly | 0 wall (job is parallel), saves about 80 s runner time on most PRs and 2 flaky reds | low: keep a nightly so base-image drift is still caught | ci.yml | A docs-only PR has no docker job; touching Dockerfile starts it |
| 8 | Drop `apt-get update` (or `command -v tmux ||`) in both jobs | 3 to 4 s | low | ci.yml | Step under 2 s |
| 9 | Larger runner (4 or 8 vCPU) | 0 alone while tests are serial; with #2 a further 10 to 20 s | cost: larger runners bill per minute even in public repos (reported 0.012 to 0.016 USD per min for 4-core, not confirmed on GitHub's page); standard public runners are free | ci.yml `runs-on` | Compare #2 wall time on both sizes |
| 10 | Shard check-mutations on push and nightly (the PR path is 18 s) | 0 per PR; main push 328 s to about 110 s | low | mutations.yml, scripts/check-mutations.ts | Same mutation count killed |
| 11 | bun install cache | 0 (install is 0.3 s) | n/a | none | Skip |
| 12 | oxlint beside Biome | under 1 s, and a second ruleset to keep in step | low | none | Skip |

Gate integrity: none of these remove a check. #7 keeps docker nightly; #10 and #6 keep full runs on main and nightly; #1 only moves existing checks earlier.

## 3. Tool facts (WebSearch, standard mode; verify before filing)

- bun test `--parallel` (worker processes, default CPU count, each file isolated), `--isolate` (experimental) and `--shard=M/N` (round-robin by sorted path, balanced to within one file, empty shard exits 0) are in the v1.3.13 release notes; docs say `--shard=2/4 --parallel` combine and `--timings` balances by recorded duration. CI pins bun 1.3 and ran 1.3.14, so the flags are available. License MIT. Ref: https://bun.com/blog/release-notes/bun-v1.3.13 and https://bun.com/docs/test/parallel.md
- Biome 2.5.14 pinned here (a comparison blog lists 2.4.x for Aug 2026, so treat that source as stale); MIT. oxlint about 1.80.x, MIT, reported 2 to 3x faster than Biome; irrelevant at a 1 s baseline. Sources are blogs, not official.
- GitHub larger runners bill per minute for public and private repos (https://docs.github.com/en/actions/concepts/runners/larger-runners). The 4-core rate is reported at 0.012 USD/min in one 2026 post and 0.016 in an older one; I could not confirm GitHub's current table. Ubicloud pricing was not found; no number is claimed.
- The runner vCPU count of `ubuntu-latest` for this repo was not measured; check `nproc` in a run before choosing worker count.

## 4. Top 5 issues (neutral titles)

1. **Add a `make fast` pre-push check that cloud sessions must run**
   - `make fast` runs biome ci, DCO, PR body lint, check-tests-only, check-mutations --base and a 3x rerun of changed tests in under 60 s.
   - AGENTS.md and the cloud session template name it as the step before any push; the 9 weakening-test and 5 Biome reds of 30 Oct to 1 Nov each fail it locally.
   - Over the next 50 PR runs the red rate falls from 27% to under 10%, measured with `gh run list`.
2. **Run the unit tests in parallel or shards in CI**
   - `bun test --parallel` or `--shard` cuts the test step from 80 s to under 40 s with the same 3417 tests counted in the junit report.
   - The required check stays one job named `push`; 5 consecutive runs show no new flaky test.
   - Reverting the flag in a branch brings the time back (proves the change is what saved it).
3. **Split lint, typecheck and tests into parallel jobs so one run shows every failure**
   - A branch with both a lint error and a failing test shows both in one CI run, with `(fail)` lines in the log.
   - Total gate coverage is unchanged (same make targets, same commands).
   - Wall time on a green PR does not rise.
4. **Make the test reporter step skip when no report exists**
   - A lint-red run shows exactly one failed step.
   - A test-red run still uploads the report and the flaky-rate summary.
   - Median time of the step stays at or under 5 s.
5. **Limit docker-build to image-related paths plus a nightly run**
   - A docs-only or tests-only PR starts no docker job; a Dockerfile, relay, verify, deploy or lockfile change does.
   - A nightly schedule still builds and smokes the image.
   - Runner minutes per PR fall by about 80 s, shown in the run list.

Left out: merge queue (#5 above) and the impact-map rollout (#6) as separate follow-ups once #1 and #2 are measured; mutation sharding because it is off the PR path.
