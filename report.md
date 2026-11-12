BRANCH: go/k5-eval-arms
HEAD: 9f6b0ed765efaa4c3996eb8fe64dbc36a5e5bdb5
## Summary
`internal/eval` now has a bare-bash control arm (ported from mini-swe-agent@04d809c), cells keyed by arm, agent, format and fixture with pass_rate_1..N, cost and malformed_count, a resumable run directory, `--replay`, and per-cell rows in `eval diff`. One commit, not one per acceptance group: the arm and the matrix share `runKey`/`runInfo`, so the control arm does not compile alone.

Measures. Non-test Go lines: 20357 before, 20936 after (+579; the repo is over budget and this adds to it). Deadcode: 68 before, 69 after. The one new entry is `WithControl`, which only `cmd/factory` can wire. I deleted `eval.Run` (tests now call `RunArm`) so it did not become dead.

`just` is not installed. I ran its recipe bodies by hand: gofmt (clean), `go vet ./...` (clean), golangci-lint v2.13.2 under go1.26.7 (0 issues), `go test -race ./...` (all ok), `CGO_ENABLED=0 go build ./cmd/factory` (ok). Each was a separate command, not a single `just check`.

## Acceptance
- aider #2(a) result JSON has pass_rate_1..N, cost, malformed_count per cell -> TestCellPassRatesCostMalformed, TestCellUnmarshalRejectsBadKey -> done
- aider #2(b) `eval diff runA runB` -> TestEvalDiffCells -> done. `eval diff` already existed. It now adds per-cell pass_rate_1 and malformed rows. A "run" is a scorecard file, not a run directory.
- aider #2(c) `--replay` re-scores stored output without a model call -> TestReplayRescoresWithoutDispatch, TestEvalReplayFlag (Dispatch panics) -> done. Replay re-runs the real gate and hidden test on the stored outcomes. Applying a stored patch to a work tree before that is the runner's job.
- aider #2(d) cell dimensions model x format x fixture -> TestEvalControlArmBesidePreset -> done, with one change. The model axis is the agent preset name, because AGENTS.md forbids model names in scorecards.
- mini #1 control arm scorecard shows control vs preset per fixture -> TestEvalControlArmBesidePreset -> done. The headline aggregate stays preset-only.
- mini #1 control prompt under 200 tokens -> TestBarePromptUnder200Tokens -> done. It is estimated at four characters per token, not tokenised.
- mini #1 limits for steps, cost, wall time and format errors, with exit_status recorded -> TestRunBareExitStatus (8 rows) -> done
- mini #2 per-instance trajectory plus atomic results file, stale-result removal -> TestResumeRerunsOnlyUnfinished -> done. Results are written by temp file and rename. The test checks that no temp file is left, not that a crash cannot corrupt the file.
- mini #2 killing a run and restarting reruns only unfinished fixtures -> TestResumeRerunsOnlyUnfinished -> done. The test simulates the kill with a dispatch error.
- mini #2 trajectory saved after every step -> TestRunBareSavesEveryStepAndClips (history lengths 4, 6, 7) -> done for the control arm. A preset arm has no step loop here, so it writes no trajectory file.
- Left out: mini #3 (pkg/sandbox, dispatch/local) and aider #1 and #3, which belong to other sessions. The upstream `swebench.yaml` prompt was not reused: the control prompt is a short original text that names the sentinel. The truncation hint is original text too.

Bite-check: I reverted each fix once and the named test went red. Sentinel exit code, consecutive format-error reset, obs clip (TestRunBareSavesEveryStepAndClips), stale removal, skip-finished, replay wrapper, stop-at-first-merge, atomic rename, preset-only aggregate, cell diff and `--tries` all went red. The step-limit revert also went red, but the run printed no FAIL line, so I did not see which test caught it.

## API change requests
- Wire `eval.WithRunner` and `eval.WithControl` in `cmd/factory/main.go`. `eval.NewCommand()` there is built with no runner, so `factory eval` fails with "no agent runner configured" today. `WithControl` is the one new deadcode entry.
- `WithRunner`'s signature gained a `format` argument. Only the tests in this package use it.

## Files outside my area
- `THIRD_PARTY_NOTICES.md`: added the `SWE-agent/mini-swe-agent@04d809c` section the provenance test requires.
- `docs/cli-reference.md`: regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory` because new flags changed the golden test.

## Gate evidence
No `just check`. Last lines of the equivalent steps:
- golangci-lint: `0 issues.`
- `go test -race ./...`: every package `ok`; `cmd/factory` passes after the regenerated doc
- `CGO_ENABLED=0 go build ./cmd/factory`: BUILD_OK

## Learnings
- `just` is missing from the cloud image, so the gate was five hand-run commands. Install it in the image.
- The brief's `git ls-files '*.go'` line count ignores untracked files, so it undercounts mid-work. Use `-co --exclude-standard`.
- A golden CLI doc test fails on any new flag, and its file sits outside every ticket's area. The brief should list `docs/cli-reference.md` as allowed.
- golangci-lint through `go run` downloads about 40 modules and nearly hit the memory limit. Preinstall the binary.
