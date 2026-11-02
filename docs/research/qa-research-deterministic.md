# Fast deterministic verification of a code change: state of the art vs KaaS Factory

Research date 30 Oct 2026. Web and public GitHub only; nothing cloned or run. Star counts from the GitHub API on that date. Anything I could not confirm against a primary source is marked UNVERIFIED.

## 1. Findings table

| Tool / source | What it actually does | Licence, stars | Speed or accuracy claim (source) | Take / skip |
|---|---|---|---|---|
| Nx affected (nx.dev/docs/features/ci-features/affected) | Git diff base..head, selects *tasks* whose declared `inputs` include a changed file; consumers of a selected task's outputs follow. Nx 24 is task-level; legacy project-level mode behind `affected.legacy`. Lockfile change affects every task by default. `--explain` says why. | MIT, stars not fetched | No numeric claim. Docs warn undeclared inputs cause missed selections. | Take the ideas (input-declared selection, `--explain`, lockfile = all), not the tool. |
| Turborepo `--affected` | Package-level affected filter against a base ref. | MIT, stars not fetched | UNVERIFIED (docs page redirected, not read). | Skip; package granularity is coarser than our map. |
| Bazel remote cache (bazel.build/remote/caching) | Action key = hash of declared inputs, command line, `--action_env`. Hit = reuse outputs (including test results) on any machine. | Apache-2.0 | Correctness depends on hermeticity: tools outside the workspace are not tracked, so two machines can wrongly share a result. Only CI should write; a poisoned cache must be wiped whole. | Take the principle: cache check results by input hash, CI-only writer. Skip Bazel itself (fewest moving parts). |
| Jest `--changedSince` / `--findRelatedTests` (jestjs.io/docs/cli) | Static import graph from changed files to tests. Needs no dynamic requires. | MIT | None. | Take for JS repos at L1. |
| Vitest `--changed`, `vitest related` (vitest.dev/guide/cli) | Same, via static module graph; experimental `recordDependencies` records loaded modules per test; "a test file without a record always runs". | MIT | None. | Take; enable recorded dependencies, it fails safe. |
| pytest-testmon (github.com/tarpas/pytest-testmon) | Records per-test executed code via coverage.py, reselects tests whose dependencies changed. Previously failed tests always rerun. Blind to static files and network services. | MIT, 1,032 | No numeric claim. | Take for Python repos at L1, with our path map as the fallback for non-code inputs. |
| Develocity Predictive Test Selection (docs.develocity.ai/predictive-test-selection) | ML on build history; always selects new, changed, recently failed and flaky tests; must-run annotations; CONSERVATIVE/STANDARD/FAST profiles; `REMAINING_TESTS` mode runs the skipped rest post-merge; simulator replays history before enabling. Needs 14 days and 50 runs of history. | Commercial | "Calibrated to catch over 99% of non-flaky test task failures" (vendor, no independent figure). | Skip the product; take the safety design (always-run set, remaining-tests sweep, simulator). |
| Meta predictive test selection (research.facebook.com/publications/predictive-test-selection) | Learned selector over historical outcomes, flake-aware. | Paper | Halved infra cost; over 99.9% of faulty changes still caught, over 95% of individual failures reported. | Evidence that selection is safe when its miss rate is measured. |
| CloudBees Smart Tests (ex-Launchable) | Subset by confidence, fixed time or percentage; confidence curve from observed runs. | Commercial | No independent benchmark found. | Skip. |
| cargo-nextest (github.com/nextest-rs/nextest) | Retries; a pass-on-retry is labelled flaky; `--flaky-result fail` makes flaky a failure; per-test overrides by filter; JUnit flaky tags. | Apache-2.0/MIT, 3,373 | n/a | Take the policy shape for every runner. |
| cargo-mutants (github.com/sourcefrog/cargo-mutants, mutants.rs) | `--in-diff` mutates only regions in a git diff; `--shard k/n` with no coordination (slice or round-robin); docs give a cost model, not timings. Docs: diff mode ignores test-only diffs and "is not a substitute for a full test run". | MIT, 1,368 | Wall clock about startup + one clean build + (mutants / shards) x (incremental build + test). Suggests 8 to 32 shards, at least 10 mutants each. | Take for Rust repos. |
| StrykerJS (github.com/stryker-mutator/stryker-js) | Mutant schemata ("mutation switching"): all mutants compiled in once, one activated per run. `coverageAnalysis: perTest` runs only covering tests per mutant. `--mutate src/a.ts:5-7` line ranges. `--incremental` reuses killed/survived results from a JSON file; one example reused 3,731 of 3,965. `ignoreStatic` skipped about 6% of mutants for about 50% speedup on Stryker's own core. | Apache-2.0, 3,302 | Project claims only. Incremental does not see changes to dependencies, env vars or snapshots. | Take for TS repos. |
| mutmut 3 (github.com/boxed/mutmut) | Fork per mutant (or forkserver), knows which tests cover each function, re-tests only mutants in functions whose source changed, `mutate_only_covered_lines`, type-checker filter drops non-compiling mutants, watches non-Python files for invalidation. | BSD-3, 1,518 | No numbers. | Take for Python repos. |
| PIT incremental (pitest.org/quickstart/incremental_analysis) | History file: reuse killed/survived when class and killing test unchanged; only superclass/outer class dependencies tracked; author calls the dependency assumption "currently unproven". | Apache-2.0, 1,884 | No numbers. | Reference design; mirror its reuse rules. |
| Google mutation testing (Petrovic and Ivankovic, ICSE-SEIP 2018; "Practical mutation testing at scale", research.google) | Diff-only mutation at code review, at most one mutant per line, suppress "arid" nodes (logging and similar), pick operators by historical usefulness. | Papers | 1.1M mutants, about 150k actionable findings across 70k+ diffs; usefulness rose from 20% to 80% with feedback (search-excerpt figures, full text not read: partly UNVERIFIED). | Take: cap mutants, filter arid code, track operator usefulness. |
| Meta ACH (arXiv 2501.12862) | LLM writes a few targeted mutants for a concern, then a test that kills each; LLM equivalence filter. | Paper | 9,095 mutants, 571 tests, 73% of tests accepted by engineers. | Take the shape for our builder-written tests. |
| Meta TestGen-LLM (arXiv 2402.09171) | Generated test kept only if it builds, passes repeatedly, and raises coverage. | Paper | 75% built, 57% passed reliably, 25% raised coverage; 73% of recommendations accepted. The "five runs" detail is from a secondary summary (UNVERIFIED). | Take as the promotion filter. |
| Google flaky data (testing.googleblog.com, Micco, May 2016) | About 1.5% of runs flaky; almost 16% of tests show some flakiness. | Blog | 2016 snapshot. | Justifies a flake policy at our scale. |
| Trunk Flaky Tests (docs.trunk.io/flaky-tests/quarantining) | Detects pass/fail on same code from uploaded results; quarantined tests still run but their failures do not fail the job; "Never Quarantine" per test; Broken tests never quarantined. | Commercial | n/a | Skip the SaaS; copy the semantics in a file. |
| dependency-cruiser | Rule file over the JS/TS import graph (forbidden, allowed, cycles). | MIT, 7,354 | Seconds. | Take at L0 for TS. |
| import-linter | Layer and independence contracts for Python imports. | BSD-2, 1,242 | Seconds. | Take at L0 for Python. |
| ArchUnit | Architecture rules as JUnit tests. | Apache-2.0, 3,884 | n/a | Only if JVM. |
| semgrep | Pattern rules over source; custom rules per repo. | LGPL-2.1, 17,363 | Seconds on a diff. | Take at L0 for "never do X" rules. |
| Hypothesis | Property-based testing with shrinking and a saved example database. | API says NOASSERTION; I believe MPL-2.0 (UNVERIFIED), 9,126 | n/a | Take for pure logic; pin `derandomize` or a seed in PR runs. |

## 2. Gaps in our approach

1. **Mutation is hand-written and whole-gate.** A find/replace plus "named test fails" is one mutant, chosen by the same agent that wrote the code, and (I infer from 14 minutes) re-runs a large part of the suite per mutant. State of the art generates every mutant inside the diff, runs only the tests that cover each mutant (Stryker `perTest`, mutmut per-function test map), compiles once (schemata), and reuses results from main (Stryker `--incremental`, PIT history, mutmut cache). The hand-written mutant proves one test bites; it says nothing about the rest of the changed lines.
2. **The selector's miss rate is never measured.** `check-affected.py` maps paths to checks by hand. Meta and Develocity both treat selection as safe only because the skipped remainder runs later and misses are counted (`REMAINING_TESTS`). We have no "would the selector have skipped this failure?" record, so a stale `impact` map fails silently.
3. **Selection is path-based only.** No coverage-derived or import-graph selection inside a check. A one-line change still runs the whole test target the map points at. testmon, Jest/Vitest related and Nx inputs narrow to the tests that touch the change.
4. **No result cache by input hash.** Identical inputs (rebase with no code change, retry after an unrelated failure, holdout re-run) re-execute. Nx, Turborepo and Bazel skip them.
5. **Test-only diffs escape diff-scoped checks.** cargo-mutants documents it: a diff that weakens or deletes tests runs no mutants. A builder agent that edits a test to go green would pass a diff-only mutation gate. Protected paths cover some of this, not all.
6. **No written flake policy.** Without "retry once, pass-on-retry counts as flaky, flaky on a new test fails, flaky on an old test quarantines with an owner", either agents retry until green (false confidence) or one flake blocks a merge (slowness).
7. **No rule for temporary tests.** Agents write tests during a session; holdouts exist; but nothing decides which builder tests become permanent, so the suite either grows with low-value tests or loses the ones that encode the acceptance criterion.
8. **Hermeticity is assumed, not checked.** Selection and caching both go wrong on undeclared inputs (env vars, tool versions, lockfiles, fixtures, snapshots). Stryker incremental and Bazel docs both call this out.
9. **Mutant usefulness is not tracked.** Google's 20% to 80% usefulness gain came from dropping arid code and operators developers ignore. We have no per-operator kill/ignore data.

## 3. Proposed layer model

| Layer | Budget | Runs where | Contents | Temporary or permanent |
|---|---|---|---|---|
| L0 static | under 10 s | agent loop, pre-commit, PR | typecheck on changed packages, lint, semgrep rules, dependency-cruiser / import-linter contracts, protected-path check, "test files deleted or assertions removed" diff check | Permanent rules only |
| L1 change-scoped tests | under 60 s | agent loop, PR | `check-affected.py` selects checks, then inside each: testmon / Vitest related / Jest `--changedSince` / nextest filter; plus the always-run set (new, changed, recently failed tests, must-run tag); results cached by input hash | Session tests run here alongside permanent ones |
| L2 acceptance and diff mutation | 1 to 3 min | PR | base-versus-head (new tests fail on base, pass on head), holdout tests, diff-only tool mutation capped at N mutants (say 30), one per line, arid code filtered, covering tests only, sharded, reusing main's incremental file; new tests run 3x to detect flake | Promotion decision happens here |
| L3 full affected suite | under 10 min | merge queue / post-merge on main | full `make check` for the merged commit, selector-miss audit (any failure in a check the selector skipped on that PR = logged miss), refresh incremental mutation and testmon data from main | Permanent |
| L4 nightly | unbounded | nightly | full-repo mutation with shards, property tests at high example counts, flake detector (rerun suite N times), quarantine review, operator usefulness report, cache-poisoning canary (clean build vs cached build diff) | Permanent |

**Temporary vs permanent.** Builder tests live in a session folder (for example `tests/_session/<issue>/`) that L1 and L2 run and the merge strips unless promoted.

**Promotion rule.** A session test is promoted to the permanent suite only if all hold:
1. It fails on base and passes on head (or it pins an acceptance criterion from the issue, named in the test).
2. It passed 3 consecutive runs at L2 with no flake.
3. It kills at least one diff mutant the existing permanent suite leaves alive, or raises line/branch coverage on changed lines (TestGen-LLM filter).
4. It runs under the per-test time budget for its layer.
Everything else is deleted at merge. Holdouts stay outside the builder's view and are never promoted by the builder; a human or the review stage moves them.

**Flake rule.** Retry once. Pass-on-retry on a test added or changed in this PR = fail (nextest `--flaky-result fail` semantics). Pass-on-retry on an untouched test = record, auto-quarantine after K flakes in a window, quarantined tests still run and report, and each quarantine has an owner and an expiry. Tests tagged never-quarantine (money, auth, tenancy) always block.

## 4. Top 8 changes, ranked by confidence gained per second saved

1. **Replace hand-written find/replace with diff-scoped tool mutation, covering tests only.** Stryker `--mutate file:lines` with `perTest`, mutmut changed-functions, cargo-mutants `--in-diff --shard`. Cap at about 30 mutants, one per line, skip arid code (logging, constants, string literals). Cost becomes roughly N x (covering tests), and every changed line is checked instead of one. Speed estimate is mine, UNVERIFIED until measured on one repo.
2. **Reuse mutation results from main.** Commit or cache Stryker `stryker-incremental.json`, mutmut's `mutants/` state, PIT history, keyed to main's sha; PRs only run mutants whose code or covering tests changed. Mirror PIT's reuse rules and force a full rerun when a lockfile, env or fixture changes.
3. **Measure the selector.** At L3, run the full gate on each merged commit and record every failure in a check that `check-affected.py` skipped for that PR. Zero misses over a window is the evidence that lets us keep L1 small; any miss becomes an `impact` map fix plus a test. This is cheap (post-merge) and is the only thing that converts "fast" into "fast and proven".
4. **Close the test-only-diff hole.** L0 check: a diff that deletes tests, removes assertions, adds skip markers or loosens snapshots fails unless the issue allows it. When tests change, L2 mutates the code those tests cover, not just the code diff. Seconds of cost, closes the most likely agent cheat.
5. **Cache check results by input hash.** Hash the inputs each `impact` entry declares plus tool versions and lockfile; skip a check whose hash already passed on CI. CI is the only writer. Saves every rebase and retry; requires declaring inputs, which also fixes gap 8.
6. **Coverage or import-graph selection inside each check.** testmon for Python, Vitest `recordDependencies` or Jest `--findRelatedTests` for TS, nextest filtersets for Rust, with an always-run set (new, changed, recently failed, must-run tagged). Typically cuts L1 from minutes to seconds; fails safe because unrecorded tests always run.
7. **Session test folder plus the promotion rule above.** Keeps the permanent suite lean and every kept test justified by a base-fail/head-pass result and a killed mutant. Low runtime cost, high long-term confidence.
8. **Written flake policy and structural rules at L0.** nextest-style flaky-fail for new tests, quarantine-with-owner for old ones; dependency-cruiser / import-linter / semgrep contracts for layering and "never do X" rules. Both are seconds, and both remove whole classes of review comments.

## What I left out

No benchmarks run. Snapshot/golden and contract tools (Pact, Schemathesis) not researched; they fit L1 (consumer) and L3 (provider).

## Sources

- https://mutants.rs/in-diff.html, https://mutants.rs/shards.html, https://github.com/sourcefrog/cargo-mutants
- https://stryker-mutator.io/docs/stryker-js/incremental/, https://stryker-mutator.io/docs/stryker-js/configuration/, https://stryker-mutator.io/blog/mutation-switching/, https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants
- https://mutmut.readthedocs.io/en/latest/, https://github.com/boxed/mutmut
- https://pitest.org/quickstart/incremental_analysis/
- https://testmon.org/, https://github.com/tarpas/pytest-testmon
- https://docs.develocity.ai/predictive-test-selection/
- https://research.facebook.com/publications/predictive-test-selection/
- https://docs.cloudbees.com/docs/cloudbees-smart-tests/latest/resources/onboarding-guide
- https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/, https://research.google/pubs/state-of-mutation-testing-at-google/
- https://arxiv.org/abs/2501.12862 (ACH), https://arxiv.org/abs/2402.09171 (TestGen-LLM)
- https://testing.googleblog.com/2016/05/ (Micco, flaky tests at Google)
- https://nexte.st/docs/features/retries/
- https://docs.trunk.io/flaky-tests/quarantining
- https://nx.dev/docs/features/ci-features/affected, https://bazel.build/remote/caching
- https://jestjs.io/docs/cli, https://vitest.dev/guide/cli
- https://github.com/sverweij/dependency-cruiser, https://github.com/seddonym/import-linter, https://github.com/TNG/ArchUnit, https://github.com/semgrep/semgrep, https://github.com/HypothesisWorks/hypothesis
