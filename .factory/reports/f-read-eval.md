# f-read-eval: split eval.NewCommand

## Demo commands
    go test ./internal/eval -run 'Golden|Short' -count=1
    ok  github.com/KaaS-team/factory/internal/eval

## Acceptance
- Golden tests pass unchanged before and after: done. `golden_test.go` pins --help for eval, diff, check,
  replay, stats and compare, plus a fake run's stdout, JSON and markdown. Committed first (89bc9f5),
  and green on both the old and the new `command.go`.
- Each new test fails with the fix reverted: done.
  - `TestCommandFunctionsStayShort` with the old file restored: `command_shape_test.go:27: command.go: NewCommand is 165 lines, cap 60; split it`.
  - The golden tests are behaviour pins and pass on the old code by design. Changing one flag help
    string makes `TestEvalHelpGolden/help-eval.golden` fail.

## Change
`NewCommand` is now flags plus wiring. New: `runFlags` (`validate`, `packsSum`), `localRunner`,
`runEval`, `runArms`, `writeScorecard`, `writeTrajectories`. `diff`, `check` and `replay` were already
separate functions. `runEval` is the longest at 50 lines; the cap is 60, not the 40 the finding names.

## Upstreams copied
None.

## Files outside my area / workflow changes
None.
