# KaaS Factory retro: 30 Oct 2026 00:00 UTC to 31 Oct 2026

Read-only research. Sources: `gh pr list/view`, `gh run list/view --log-failed`, issue comments, branch protection API, and `git merge-tree` replays of every "Merge main into" commit on a fresh clone. Every number below comes from those sources. Raw pulls are in `scratchpad/retro/`.

## 1. What happened in the window

- 28 PRs across 11 repos (kaas.team: 0; it returns 404 to this token). 26 merged, 2 closed.
- KaaS-factory: 14 PRs (#278 to #343), 12 merged. Release v6.2.0 shipped with four binaries and checksums.
- Other repos: factory-install #5 to #8, blueprint #10 and #15, auditor #9, factory-config #2, playbooks #3, and one README PR each in homebrew-tap, .github, factory-mcp, factory-plane, factory-plugins.
- KaaS-factory CI: 85 runs. `ci`: 32 success, 7 failure, 3 cancelled. `mutations`: 26 success, 7 failure, 9 cancelled.
- Zero PR reviews and zero PR comments from a reviewer or judge on all 28 PRs. Every "Verify verdict" section was written by the authoring session.
- Zero PRs came from the factory pipeline itself. The last `factory/` branch PR is #253 (28 Oct). Issues labelled `factory:failed` or `factory:needs-human` (#120, #123, #128, #134, #139, #145, #151, #165) have no activity since 27 or 28 Oct. All work in the window was done by interactive and cloud sessions.

Open to merge (minutes): auditor#9 64, #336 53, #280 38, #281 32, blueprint#15 27, #279 25, #284 19, #340 17, #341 15, #339 8, #337 7, #338 6, #342 2, #343 2. Twelve PRs outside KaaS-factory merged in under 2 minutes, including factory-install#7 (+700) and playbooks#3 (+409).

## 2. Shortcomings, with evidence

### S1. `tests/mutations.json` is a merge-conflict magnet
- Evidence: replaying the parents of each "Merge main into" commit with `git merge-tree`: 8 of 9 conflicted on `tests/mutations.json` (1b60a1e, 2d43ca3, d2bec48 in #341; e651ee4, 6f73d1b in #340; 84b1e0c, 98bca5a in #339; 05c9228 in #338). 1b60a1e also conflicted on `quality-baseline.json`, 05c9228 on README.md. Only 57f74c0 (#281) merged clean.
- Four PRs opened between 21:56 and 22:09 (#338 to #341) needed 8 merge commits between them; each push restarted CI (about 2 min) and mutations.
- The problem and its fix were already filed: #168 (27 Oct, "Find shared append-only files...") and #151 (27 Oct, "Re-sync quality baseline and mutation list after a rebase"). Both still open.
- Root cause: one JSON array that every PR appends to its tail; squash merges always collide.
- Fix (core): one file per entry under `tests/mutations/` (loader reads the folder), or a registered union merge driver for append-only JSON lists; generalise as `factory hotspots` per #168.
- Effect: removes the merge-main loop for parallel PRs; about one CI cycle saved per PR per sibling merge. Size S to M. Deterministic.

### S2. Stale mutation anchors are found 15 to 18 minutes late, and only for touched files
- Evidence: the anchor `"src/cli.ts": 976` on "quality: a line baseline cannot keep slack" went stale in #278, #279, #336 and #341 and was re-anchored by hand three times (git log -p of `tests/mutations.json`: 985, 987, 976). Runs 41038471213, 41039875342, 41129333918, 41136258834 report `"find" matches 0 times in quality-baseline.json`.
- In #336 the anchor failure surfaced at 21:30, 18 minutes after the push (run 41129333918); the fix and a second full run took until 21:57. About 36 of the PR's 53 minutes were mutation waits.
- Scheduled run 41038525346 shows 12 of 923 mutations failing on main; #278 showed 14, #279 showed 15. #280 then repaired 14 anchors by hand.
- Root cause: `scripts/check-mutations.ts` validates `find` only inside the per-mutation worker, after the repo copy and the clean test run; nothing validates all anchors cheaply. Mutations anchored on live numbers (line counts) go stale on any edit.
- Fix (core): a sub-second `check-mutations --anchors` that checks every entry's `find` matches exactly once, wired into the required `push` job and `make check`. Ban anchors on `quality-baseline.json` values; point the slack mutation at a fixture.
- Effect: anchor drift is caught in the PR that causes it, in under 2 min. Size S. Deterministic.

### S3. The mutation job is not required, so main stayed red for about 50 hours
- Evidence: branch protection on KaaS-factory main requires only `push` (strict: false, no reviews). #279 merged with `check-mutations: FAILURE`. Its stage comment on #201 says the job "failed only on anchors main also fails", but #279 raised the count from 12 (schedule run) to 15 (run 41039875342, including the new cli.ts anchor). Main mutation runs failed from 28 Oct 09:46 until #280 merged at 11:51 on 30 Oct; the 29 Oct nightly hit the 20-minute job timeout and was cancelled with no verdict (run 40854730503). #187 ("Fix the eight broken mutations...", 28 Oct) is still open; #280 says "Closes: nothing (no planned issue)".
- Root cause: the job took 14 to 19 min, so it was kept off the push verdict (comment in `mutations.yml`). After #337 it takes 10 to 30 s on a PR, so that reason no longer holds.
- Fix (core): make `check-mutations` a required check; shard the nightly run so it finishes inside its timeout; on a red main run, open or update one tracker issue automatically.
- Effect: no red PR merges; main red time drops from days to one merge. Size S. Deterministic.

### S4. The line-count ratchet creates bookkeeping commits and conflicts
- Evidence: test "every line baseline is the file's current size" failed on #336 (run 41128806133); the PR needed `chore: bump the state.ts line baseline` (fff4414) and `fix: follow the cli.ts line baseline in the slack mutation` (9ea0b18). That is 2 of its 6 commits. `quality-baseline.json` changed in #284, #336, #341 and conflicted in 1b60a1e.
- Root cause: the baseline must equal the file size exactly and is hand-edited; every PR that touches a capped file edits one shared JSON.
- Fix (core): a script writes the baseline from the tree (down-only ratchet, refuses growth); the runner calls it after build and after a rebase (the #151 spec). Pair with S1's merge driver for the file.
- Effect: removes one bookkeeping commit and one conflict source per PR that edits a large file. Size S. Deterministic.

### S5. Mechanical CI failures that a local hook would have prevented
- Evidence: #278 failed the DCO step (run 41038471315). The session could not amend and force-push, so it opened #279 as a copy ("Superseded by #279 (same change, signed off for DCO)"). #279 then needed two `style: biome format` commits (889a591, 77be2fe) after run 41039253631 failed on formatting; 4 PR runs in 4 minutes were cancelled. #340 claimed "check-affected.py --run: pass, zero warnings, local" yet failed the tests-only step in CI (run 41135216552), because that step and the DCO and PR-body steps run only under `if: github.event_name == 'pull_request'`.
- Root cause: PR-only checks have no local entry point; formatting and sign-off depend on the agent remembering.
- Fix (core, template): a `commit-msg` hook that adds the sign-off trailer, a `pre-push` hook that runs the formatter on changed files and runs the same PR-only scripts CI runs, reading the PR body from the file the session will submit.
- Effect: removes the DCO, format and tests-only failure classes (3 of 7 `ci` failures). Size S. Deterministic.

### S6. Cloud sessions could not push, and could not push workflow files
- Evidence: the ledger comment on #125 records three cloud sessions for the curl installer (about 50 s each, 6 turns each) that were all denied `git push`; the work was redone locally as factory-install#5. Root cause per #201: the template's `.claude/settings.json` denied every push; fixed by factory-install#6 and blueprint#10. Workflow files were staged under `ci/` and moved by a later local commit three times: auditor#9 (last commit "ci: move the workflows into .github/workflows"), #340 (0ce7bc6 moved `ci/flakes.yml` and deleted a 157-line staged copy of `ci/ci.yml`), #341 (1b60a1e moved `ci/release-binaries.yml`). A security review after merge (#282 comment) found the branch-push glob denies do not cover every refspec form; both repos needed a server-side ruleset as a stopgap.
- Root cause: no preflight proves a session can push before it starts work; the session token cannot write `.github/workflows/**`; push policy lives in per-repo glob lists.
- Fix (core): session preflight pushes an empty probe branch and checks workflow-write scope before dispatch (#324's supervisor preflight is the place); the runner, not the agent, pushes `.github/workflows/**` changes; `guard-paths.sh` parses push refspecs (#282).
- Effect: no wasted sessions, no staged-file shuffles. Size M. Deterministic.

### S7. New checks fired on our own tree
- Evidence: `check-tests-only` (#340) flagged its own fixtures and `tests/mutations.json` (run 41135216552), fixed in 058ae1b. The semgrep rule `js-shell-exec-interpolated` flagged an SQLite `db.exec` call in `src/state.ts` (run 41128289244), suppressed in 163a3bd. The prose check flagged a word in #304 (run 41119663829), worked around by a rename (e6afd25).
- Root cause: a new check is wired before it is run against HEAD and the repo's own fixture folders; rule receivers are not typed (any `.exec` matches).
- Fix (core): a structural test that runs every CI check script against the current tree in `make check` (a new check that is red on HEAD fails its own PR before CI); scope the semgrep rule to process-spawn receivers.
- Effect: removes one push-fix cycle per new check. Size S. Deterministic.

### S8. No independent verdict; templates checked for headings only
- Evidence: 0 reviews across 28 PRs. #339's body says "Verify verdict: Pending CI" and passed `check-pr-body`; #338 and #340 say "Pass". #336 says "Full gate runs in CI". factory-install#6 and blueprint#10 (settings that control what an agent may push) merged in 27 s and 66 s; the bypass forms in #282 were found afterwards. #201's closing comment states the downloaded binary was never run on a clean machine. PR #304 put private research into a public repo and was closed 11 minutes later; no check caught it.
- Root cause: the factory's verify and judge stages run only on factory-run issues; hand and cloud PRs bypass them. `check-pr-body.ts` asserts section headings, not content.
- Fix (core): `check-pr-body` rejects placeholder verdicts ("Pending", bare "Pass") and requires a test or run reference in Gate evidence; a required independent verify job (the factory's verifier, run against any PR) for diffs that touch guard, settings, workflow or security paths; a deterministic check that blocks files under `docs/research/` in public repos.
- Effect: closes the self-grading gap where risk is highest. Size M. Content and path checks deterministic; the verifier uses a model.

### S9. Repos with no CI and no shared PR policy
- Evidence: homebrew-tap, .github, factory-mcp, factory-plane, factory-plugins have zero workflow runs; their "honest README" PRs merged in under a minute with no checks. auditor#9 and factory-install#5 skipped the PR template (the check from #281 exists only in KaaS-factory). auditor#9's first CI job sat queued from 20:44 to 21:42 because its `runs-on` label is not available to the org; the fix was "ci: run on GitHub-hosted runners".
- Root cause: per-repo CI copies; no org-level floor; no lint for runner labels; no alert on a queued job.
- Fix (core): an org reusable workflow in `.github` (PR body, DCO, prose, README-accuracy test like #338) that every repo calls; `factory doctor` lints `runs-on` against the labels the org can serve and fails a repo with no workflow; the supervisor flags a job queued over 10 minutes.
- Effect: saves the 58-minute queue class; every repo gets the same floor. Size S. Deterministic.

### S10. Known toil issues are not prioritised by how often they bite
- Evidence: #168 and #151 (conflicts) and #187 (broken mutations) were open with full acceptance criteria before the window. In the window the conflict bit 8 times and the stale anchors failed 7 mutation runs, while 29 new feature intake issues were filed (#305 to #323, #326 to #335). #280 fixed #187's problem without linking it.
- Root cause: priority is set at intake; nothing feeds CI failure frequency back into the queue.
- Fix (core): fingerprint each CI failure (check name plus normalised message), map fingerprints to open issues, raise priority automatically after N hits, and have the PR body check suggest open issues whose fingerprint the diff clears.
- Effect: the scheduler fixes multipliers first. Size M. Deterministic.

### S11. Flaky subprocess tests turn main red
- Evidence: run 41137926109 (main, 857b2ad from #341) failed "the export script writes the ledger from a state DB..." with "this test timed out after 5000ms" and "killed 1 dangling process"; the next main run passed. The mutation baseline for "a high-risk task runs two review sessions..." failed under parallel load in runs 41039875342 and 41041933715; #280 notes it "did not reproduce".
- Root cause: tests that spawn `bun` synchronously keep the default 5 s timeout; cold starts on a loaded runner exceed it.
- Fix (core): a structural test that any test calling `Bun.spawn`/`spawnSync` sets an explicit timeout; main failures auto-enter the quarantine ledger added in #340.
- Effect: fewer false reds on main. Size S. Deterministic.

### S12. Smaller items
- CI noise: every early failure also logs `JUnit report not found at: reports/junit.xml` from the test reporter step (runs 41038471315, 41039253631, 41135216552), which hides the real error. Guard the step on the file existing. S, deterministic.
- Cancelled main mutation runs: 2 main pushes (21:58, 22:03) were cancelled by the next push, so 06c2713 and 0fbd4df never got a mutation verdict, though #325's comment says "CI green on main 06c27139". Report the verdict per merged SHA, not per branch. S.
- Label hygiene: #254 and #255 are closed as duplicates but still carry `factory:needs-human` and `factory:needs-info`. 14 issues were closed as duplicates in one sweep on 30 Oct (09:46), so intake created them; #268 (duplicate parking) is open. S, deterministic.
- Stage summaries, duplicate closures and the ledger were typed by hand as issue comments; the runner already has the data.

## 3. Work an LLM did that a script could do

| Work | Evidence | Deterministic replacement |
|---|---|---|
| Resolve `tests/mutations.json` conflicts | 8 merge commits | per-entry files or union merge driver (S1) |
| Re-anchor mutations | #280 (14 entries), 9ea0b18, ca5d3d0 | anchor check plus fixture anchors (S2, S4) |
| Bump line baselines | fff4414 | baseline writer (S4) |
| Format fixes, DCO resubmission | 889a591, 77be2fe, #278 to #279 | hooks (S5) |
| Move staged workflow files | auditor#9, 0ce7bc6, 1b60a1e | runner pushes workflows (S6) |
| Stage summaries and duplicate closures | comments on #201, #283, #325, 14 duplicate closures | runner-posted summaries from run state |

## 4. What worked and should stay

- #337 diff-scoped mutation selection: PR mutation runs went from 14 to 19 min to 10 to 30 s (for example #340's run 22:01:11 to 22:01:23, #341's run 22:09:57 to 22:10:27). Open-to-merge dropped from 19 to 53 min to 2 to 17 min after it merged.
- The mutation check itself found real problems: 14 stale anchors and one guard that no longer guards anything ("watch: a stale poll...", dropped in #280 with a reason).
- #281 PR body check: every KaaS-factory PR after it carries the template.
- #340 tests-only and flake policy, #338 README accuracy test, #339 supervisor preflight: the right direction (move judgement into checks).
- Honest stage comments: #201 states what was not verified; #125 records wasted sessions and sets a rule.
- E0 shipped end to end in one day: T1 to T3, release workflow, v6.2.0 with checksums checked after the tag.
- Server-side rulesets on main as the stopgap for agent push.

## 5. Ranking

Score = impact on autonomy and speed (1 to 5) divided by effort (S=1, M=2, L=3).

| Rank | Fix | Impact | Effort | Score | Model-free |
|---|---|---|---|---|---|
| 1 | Anchor check in the required job (S2) | 5 | S | 5.0 | yes |
| 2 | Make mutations required, finish the nightly (S3) | 5 | S | 5.0 | yes |
| 3 | Pre-push and commit-msg hooks with PR-only checks (S5) | 4 | S | 4.0 | yes |
| 4 | Per-entry mutation files or merge driver (S1) | 5 | S/M | 3.3 | yes |
| 5 | Baseline writer, no live-number anchors (S4) | 3 | S | 3.0 | yes |
| 6 | New checks self-test on HEAD (S7) | 3 | S | 3.0 | yes |
| 7 | Org CI floor and runner-label lint (S9) | 3 | S | 3.0 | yes |
| 8 | Subprocess test timeouts, main flake quarantine (S11) | 3 | S | 3.0 | yes |
| 9 | Evidence-bearing verdict and independent verify on risky paths (S8) | 5 | M | 2.5 | partly |
| 10 | Session push preflight, runner pushes workflows (S6) | 4 | M | 2.0 | yes |
| 11 | Failure fingerprints drive priority (S10) | 4 | M | 2.0 | yes |

The candidate list below folds rank 8 (S11) into candidate 6, since it is one structural test, which leaves room for S6 and S10. Candidates are grouped by theme, not strictly by score.

## 6. Top 10 candidate issues

### 1. Validate every mutation anchor in the required check
Why: anchors drifted in #278, #279, #336 and #341 and were found only after a 15 to 18 minute mutation run, or not at all on files the PR did not touch. Checking that each `find` matches exactly once costs milliseconds and belongs in the verdict that blocks merge.
Acceptance:
- `bun scripts/check-mutations.ts --anchors` exits non-zero and names the entry when any `find` matches 0 or more than 1 times, and finishes in under 2 s on the current list.
- `make check` and the `push` job in `ci.yml` run it; a test asserts both wirings.
- A mutation that makes the anchor check always pass turns its test red.

### 2. Make check-mutations a required check and give the nightly a verdict
Why: #279 merged with the job red and main stayed red for about 50 hours; the 29 Oct nightly timed out with no verdict. Since #337 the PR job takes seconds.
Acceptance:
- Branch protection (or ruleset) for main lists `check-mutations`; a test reads the repo settings file the factory applies and asserts it.
- The nightly run is sharded so each shard finishes under its timeout; a test asserts shard count times the measured per-mutation budget stays under the timeout.
- A red main mutation run opens or updates exactly one tracker issue; a test with a fake tracker asserts one issue after two red runs.

### 3. Ship commit-msg and pre-push hooks that run the PR-only checks
Why: DCO (#278), formatting (#279) and the tests-only check (#340) failed in CI after local gates passed, and #278 had to be resubmitted as #279.
Acceptance:
- The template's `commit-msg` hook adds a sign-off trailer when missing; a test commits without `-s` and `scripts/dco.ts` passes.
- The `pre-push` hook formats changed files and runs `dco.ts`, `check-pr-body.ts` and `check-tests-only.ts` against the base; a test pushes a branch with an unformatted file and a weakened test and asserts the hook exits non-zero.

### 4. Remove the append-only conflict on tests/mutations.json
Why: 8 of 9 "Merge main into" commits in the window conflicted on it (#338 to #341). #168 and #151 already describe the fix.
Acceptance:
- Two branches that each add a mutation merge in either order with no conflict; a test proves it with real git.
- The loader reads every entry; the count equals the old list; names stay unique (test).
- `check-mutations` and `mutation-select` give the same selection for a diff before and after the change (test on a fixture diff).

### 5. Write quality-baseline.json from the tree and stop anchoring on live counts
Why: line-cap bumps cost #336 two of six commits and broke the slack mutation three times.
Acceptance:
- One script rewrites the baseline from current line counts and refuses any cap increase; a test grows a capped file and asserts refusal.
- The runner calls it after build and after rebase; a test rebases two branches that shrink different files and ends with both caps.
- No entry in the mutation list anchors on `quality-baseline.json`; a structural test asserts it.

### 6. Every CI check runs green on HEAD before it is wired
Why: `check-tests-only` flagged its own fixtures (#340), semgrep flagged an SQLite call (#336), the prose check flagged #304. Each cost a push and a CI cycle.
Acceptance:
- A structural test enumerates every script `ci.yml` calls and runs each against the current tree, failing if any is red on HEAD.
- The semgrep shell-exec rule does not match a `Database` `.exec` call; a fixture test asserts a match on `child_process.exec` and no match on `db.exec`.
- Any test that calls `Bun.spawn` or `Bun.spawnSync` sets an explicit timeout (structural test), covering the main flake in run 41137926109.

### 7. Org CI floor and runner-label lint
Why: five repos have no CI at all; auditor#9 waited 58 minutes on an unavailable runner label; auditor#9 and factory-install#5 skipped the PR template.
Acceptance:
- `factory doctor` fails a repo with no workflow, and fails a `runs-on` label not in the org's allowed list for that repo's visibility (fixture tests for each).
- Each KaaS-team repo calls one reusable workflow from `.github` that runs the PR body, DCO and prose checks; a test lists the repos' workflows and asserts the call.
- The supervisor reports a job queued over 10 minutes; a test with a fake clock asserts one report.

### 8. Session preflight proves push before work starts; the runner pushes workflow files
Why: three cloud sessions were denied push and their work was redone locally (#125); workflow files were staged under `ci/` and moved by hand three times (auditor#9, #340, #341).
Acceptance:
- Preflight pushes and deletes a probe branch and checks workflow-write scope; a session is not dispatched when either fails, and the reason is posted once (test with a fake SCM).
- A diff under `.github/workflows/**` produced by an agent is pushed by the runner; a test asserts the agent's push refuses that path and the runner's push carries it.
- `guard-paths.sh` blocks every push form to the default branch, a delete, and an empty-source refspec; one test per form (#282).

### 9. CI failure fingerprints set issue priority
Why: #168, #151 and #187 were open with acceptance criteria while their failures recurred 15 times in one day and new feature issues were filed ahead of them.
Acceptance:
- Each failed run yields a fingerprint (check name plus normalised first error); a test feeds two runs with different SHAs and line numbers and gets one fingerprint.
- A fingerprint seen N times (config) raises the linked issue to P0, or opens one; test with a fake tracker.
- `check-pr-body` lists open issues whose fingerprint the PR's checks cleared, so "Closes: nothing" cannot hide #187 (fixture test).

### 10. Evidence-bearing verdicts and an independent verify on risky paths
Why: 0 reviews on 28 PRs; "Verify verdict: Pending CI" passed the template check (#339); push-policy changes merged in under 70 s and a bypass was found afterwards (#282); private research reached a public repo (#304).
Acceptance:
- `check-pr-body` rejects a Verify verdict that is empty, "Pending" or a bare "Pass", and requires a test path or run reference in Gate evidence (fixture tests).
- A diff touching `.claude/settings.json`, `.github/workflows/**`, guard hooks or security scripts requires the factory verify job's pass before merge (test on the path matcher).
- A public repo refuses new files under `docs/research/` (test on a fixture diff and repo visibility).

## 7. Not covered

- kaas.team returned 404 to this token, so its PRs and runs are not counted.
- Cloud session transcripts were not available; session outcomes come from issue comments (#125, #201, #272, #273) and PR bodies.
- No factory pipeline runs happened in the window, so stage-level metrics (plan reuse, verify rounds, judge accuracy) could not be measured.
