BRANCH: cluster/v6.4-check-export
HEAD: 0babc11e00b8a46278eb8c29bd8fbf24fc92c13e
## Summary
Stage rows in `factory learn --export` now carry `checks` (name, pass or fail) and `findings` (each naming its check), and `scripts/check-value.ts` ranks per check with an even share of the stage cost.
## Issues
- #627: done.
  - Each exported stage row lists its checks with pass or fail -> `exported stage checks (#627) > a stage row lists its checks and each finding names its check` (tests/learn-export.test.ts) and `each stage row lists the checks it ran...` (tests/holdout.test.ts, runs the real build and verify steps) -> tests/mutations/export-drops-the-checks-a-stage-ran.json, stage-checks-flush-skips-the-stamp.json, verify-step-does-not-record-its-checks.json
  - Each exported finding names the check -> same tests -> export-drops-the-check-a-finding-names.json
  - check-value reports per check; never-catching check named with cost -> `check-value per check > a check that never catches is named in the report with its cost` (tests/check-value.test.ts) -> check-value-credits-no-check-for-a-failed-check.json
  - Checks recorded: gates (build, verify), holdout, proof, mutations, acceptance, reviewer (verify), qa (pr). Two commits (second fixes a semgrep mark and the rerun baseline).
## Staged workflow changes
none
## Checkpoints
#627: 1 yes (see outside area), 2 yes, 3 yes, 4 yes (tests failed before: holdout test and the legacy-DB migration test caught real bugs), 5 DEVIATION noted: quality-baseline/lines/src__engine__steps.ts.json raised 540 -> 548 with --allow-raise; I moved the logic into src/stage-checks.ts and the 8 call lines left cannot fit under the cap. tests/rerun-baseline.json lost learn-export.test.ts (it now recreates the temp root), 6 yes, 7 yes.
## Files outside my area
- src/engine/steps.ts: the stage runner that knows each check result; 8 call lines.
- quality-baseline/lines/src__engine__steps.ts.json: cap raise above.
- tests/rerun-baseline.json: shrank by one entry.
- tests/holdout.test.ts: wiring test through the real step harness.
## Gate evidence
make fast: ok
## Risk and rollback
Low. Columns `checks` and `findings` are added to stage_runs on first use (no migration in state.ts, which stays untouched). Revert the two commits to roll back; the columns stay and are ignored.
## Learnings
- steps.ts and state.ts sit exactly at their line caps: any call site needs --allow-raise or a prior extraction. The factory default should leave headroom or name the file in the brief.
- tests/config-hash-stamp.test.ts fails under --rerun-each 3 on its own (module-level mkdtemp without mkdirSync(tmpdir())); not mine, not baselined.
- Full make test: tests/licensing.test.ts times out and lean-resources fails under load; both pass alone.
- Pending check notes are keyed per issue, so a verify-bound note must not be flushed by build; closeBuild stamps directly.
