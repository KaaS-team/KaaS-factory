BRANCH: go/k7-trajectory
HEAD: 372a9db3addc03f00eedc2cb65c0004fecf41827
## Summary
Added `internal/eval/trajectory` (one JSON per task with steps, final state and cost; offline stats and compare; checksum-checked replay) and hooked `eval stats`, `eval compare` and per-run trajectory writing into the eval command. Only ticket #2 was done.
## Acceptance
- One JSON per task (steps, state, cost) plus `eval stats` and `eval compare` that need no model -> TestEvalWritesTrajectoriesAndCompareStatsReadThem, TestWriteReadReplayReproducesDiff, TestSummarize, TestCompare, TestCommandsOffline -> done
- Two runs compared with no network -> TestEvalWritesTrajectoriesAndCompareStatsReadThem (two runs of the real `eval` command, then `compare` on a command built with no runner) and TestCommandsOffline -> done
- Replay of a recorded run reproduces the same final diff -> TestWriteReadReplayReproducesDiff, TestReplayRejectsBrokenFiles -> done for the trajectory file: Replay returns the last step's diff and checks it against the recorded checksum. It does not apply patches to a repo; that belongs to `internal/eval/replay`, outside my area.
Bite-checks (each revert run, test went red): checksum check in Replay (TestReplayRejectsBrokenFiles), Replay call in Load (TestReadAndLoadErrors), duplicate-task check (TestReadAndLoadErrors), fixed/regressed direction, pass-rate state, median sort (TestSummarize), compare registration, merged-to-state mapping (eval command test). A first mutation (submission-vs-diff comparison in Replay) stayed green, so I deleted that redundant check.
Order caveat: I wrote the package code before its tests, then added tests and bite-checked afterwards; the command-level test was seen red before the hook.
## API change requests
none
## Files outside my area
- docs/cli-reference.md: regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory`; TestCLIReferenceFresh fails without it.
- internal/eval/command.go and command_test.go: the hook (eval command file, in area).
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 under go1.26.7 ("0 issues."), `go test -race ./...` (all ok, last lines `ok .../pkg/agentrun`, `ok .../pkg/sandbox`), `CGO_ENABLED=0 go build ./cmd/factory` (BUILD-OK). The lint and race-test runs were done on the tree before the last small change (Replay called from Load); after it I re-ran gofmt, vet, deadcode and `go test -race` on ./... and the build.
## Measures
- Non-test Go lines (brief's command): 20980 before, 21328 after (+13 in command.go, +335 new package). The repo stays far over the 8000-line budget; I did not find anything my change made redundant to delete.
- Deadcode: 70 before, 70 after (Replay was unreachable until Load called it).
## Learnings
- `golangci-lint` takes minutes and refuses to run twice in parallel; start it once in the background.
- Sandbox `sleep` is blocked; wait with `until` loops.
- Adding a subcommand changes docs/cli-reference.md; the brief's area list should name it.
