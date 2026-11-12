BRANCH: go/upgrade
HEAD: 7a68d51f6bbf713891963c883fe461d305194839
## Summary
Added `internal/upgrade` with Plan, Decide, Judge (licence plus Decide), Apply and a cobra `upgrade` command. Everything is in one commit rather than one per acceptance group.
## Acceptance
- Plan: zero, zero, one candidate -> TestPlan -> done
- Decide table with reasons -> TestDecide -> done
- Apply changes only the bumped entry (golden) -> TestApplyGolden (testdata/apply.lock.golden) -> done
- PR body has no token count, cost or model name; operator file does -> TestApplyBodyHasNoOperatorDetail -> done
- Licence change MIT to AGPL refuses -> TestJudgeRefusesLicenceChange -> done
## API change requests
none
## Files outside my area
none. `cmd/factory/main.go` still needs `packs` -> `upgrade.NewCommand()` mounted by its owner. The `eval.Scorecard` for the real eval comes from `--baseline` and `--candidate` JSON files, since eval.Run needs deps I do not own.
## Gate evidence
`just` is missing; ran the recipe bodies by hand (gofmt, vet, golangci-lint v2.13.2, go test -race ./..., static build). All passed: lint "0 issues.", every package "ok", including internal/upgrade and internal/provenance.
## Learnings
- `just` is not installed in the cloud image; install it in the environment setup.
- Module path is github.com/KaaS-team/factory, not KaaS-factory; the brief's name misleads.
- Command and Apply tests passed on first run after code; the red step was only seen as compile failure for Plan/Decide.
- Never ran the Go gate's `skills-ref`-style extras; the brief's `just check` equals the hand-run recipes.
