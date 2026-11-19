# f-holdout report

## 1. Demo commands
```
factory eval run --workflow default --agent claude --split dev        # dev samples only (default)
factory eval run --workflow default --agent claude --split holdout    # holdout, only when named
factory eval splits evals/2026-11-12-default-claude.json
| Split | Samples | Merged | Pass rate |
|---|---|---|---|
| dev | 1 | 1 | 1.00 |
| holdout | 2 | 1 | 0.50 |
```
The first two commands need an agent, so only `splits` and `--help` were run for real. Tests cover the runs with fakes.

## 2. Acceptance
- Split stable across runs (sha256 of `fixture/ticket`, 20% holdout): done, `TestSplitIsStableAcrossRuns`.
- Dev runs never load a holdout sample: done, `TestDevRunNeverLoadsHoldoutSample` (also checks no flag means dev, and `--split all` is refused).
- Golden test of the side by side report: done, `testdata/golden/split-report.golden`.
- Each new test fails with the code reverted: done. Stable: `holdout share 94 of 1000, want about 20%` (hash changed). Dev: `args []: 10 tickets, want 30` (filter pointed at holdout). Filter: `dev matrix holds holdout sample alpha/2`. Golden: `split-report.golden differs from golden`.
- Functions over 60 lines split: `runTicket` (new `scoreEpoch`) and `RunArm` (new `runTries`).
- Side effect: the default run is now dev only, so the real fixtures run 3 of 5 tickets. Existing test counts and run goldens were updated.

## 3. Upstreams copied
Inspect AI (MIT): task, sample id and split shape only. No code copied.

## 4. Outside my area / workflow changes
Generated file `docs/cli-reference.md` regenerated (`UPDATE_GOLDEN=1 go test ./cmd/factory`) so the new `--split` flag and subcommands show; `TestCLIReferenceFresh` fails without it. `eval.NewCommand()` is already registered in `cmd/factory/main.go`. `eval run` and `eval splits` are subcommands of it.
