BRANCH: go/k4-packs-upgrade
HEAD: 61e25bdf0ae020ecf46f43812d24c238f4c4f782
## Summary
`packs upgrade` and the lock-bump rules already existed on `next`. I left one self-update (internal/selfupdate), judged bumps with `eval.Compare`, and table-tested every refused licence.
## Acceptance
- One self-update implementation remains -> selfupdate.TestCommand, TestCommandBadChecksumKeepsTheBinary -> done. Survivor: internal/selfupdate (download, checksum, atomic replace). Deleted: internal/upgrade/self.go, a 42-line wrapper, and its tests; its cobra command moved to selfupdate.NewCommand and keeps the same `factory upgrade` name, flags and output.
- Better or same bumps the lock, worse leaves it untouched and prints the reason -> upgrade.TestRunAppliesOrRefuses, TestDecide, TestRunDryRunWritesNothing (fake resolver Upstream and fake Scorer) -> done. Decide now calls eval.Compare; breaking that call turned TestDecide red.
- AGPL, CC-BY-SA or unknown licence refuses the bump -> upgrade.TestJudgeLicence (MIT, Apache-2.0, AGPL-3.0, CC-BY-SA-4.0, NOASSERTION, empty) -> done.
## API change requests
none. Request to the eval owner: `eval.Scorecard.Model` is kept only because internal/upgrade's operator file prints it (and TestApplyBodyHasNoOperatorDetail pins that); drop both together.
## Files outside my area
- cmd/factory/main.go: one line, `upgrade.NewSelfCommand` -> `selfupdate.NewCommand`, needed to delete the wrapper.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand (GOTOOLCHAIN=go1.26.7): gofmt -l clean, go vet ./... clean, golangci-lint v2.13.2 "0 issues.", go test -race ./... all ok, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK.
Measures: non-test Go lines 20357 -> 20351 (about +6 net: the command test file I added outweighs the 42-line wrapper and Decide logic removed). Deadcode 68 -> 68 lines.
## Learnings
- Scope was mostly already done on `next`; read the existing packages before planning.
- A `git checkout` used to undo a mutation also discarded uncommitted work; commit before mutating.
- `just` missing in cloud sessions; the factory default image should include it.
