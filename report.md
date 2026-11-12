BRANCH: go/init
HEAD: 96a5b6270b771a57d3a0e7b596d8657585188eeb
## Summary
`internal/initwiz` adds `initwiz.NewCommand()` (`init`): a huh v2 form, or `--yes --tier --tracker`, writes `.factory/factory.yaml` from a tier preset and nothing else. It refuses to overwrite without `--force`, and the file loads through `internal/config`. The shadow-mode and fork-safe-trust parts of the regulated and oss presets are blocked: config has no key for them.
## Acceptance
- For each tier, `--yes` writes a file that `internal/config` loads, with the preset values -> TestYesWritesPresetPerTier, TestRegulatedNeverAutoMerges, TestRejectsUnknownChoices -> done, except regulated "shadow mode on" and oss "fork-safe trust": blocked (no config key, an unknown key fails Load). regulated writes approval always, auto_merge false and requester_cannot_approve true; oss writes local and approval always.
- An existing file is not overwritten without `--force` -> TestNoOverwriteWithoutForce, TestWritesOnlyFactoryYAML -> done
- Interactive form in huh accessible mode, scripted input, writes the same file as `--yes` -> TestFormMatchesYes (all 6 tiers, byte equal) -> done
- Repo default from the origin URL (temp git repo) -> TestRepoDefaultFromOrigin (4 URL shapes), TestNoOriginLeavesRepoUnset -> done
## API change requests
None to `internal/api`. Config request: add keys for shadow mode (bool) and trust (string, e.g. fork-safe) to `internal/config/keys.go`, then add them to the regulated and oss presets.
## Files outside my area
`go.mod`, `go.sum`: added `charm.land/huh/v2 v2.0.3` (go directive 1.25.8, so go stays 1.26.0; not the latest 2.0.x). Nothing else.
## Gate evidence
No `just` here. Recipe bodies run by hand: gofmt (`test -z "$(gofmt -l ...)"`) clean, `go vet ./...` clean, golangci-lint v2.13.2 with GOTOOLCHAIN=go1.26.7: `0 issues.`, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok (binary built to /tmp, none left in the tree).
Bite proof: with the `--force` guard disabled, TestNoOverwriteWithoutForce failed; with scaleup batch 4 changed to 3, TestYesWritesPresetPerTier/scaleup failed. Both reverted.
Not done: the command is not mounted (`cmd/` is outside my area; the supervisor mounts it). Preset numbers beyond the ticket (oss slots 2, regulated slots 3, enterprise team_day 250 and month 5000) are my choices.
## Learnings
- huh forms buffer their input, so two forms on one reader lose the second's lines; read one byte at a time (`oneByte`).
- The first golangci-lint run took minutes; start it in the background first.
- A tier table naming values with no config key (shadow, trust) should be checked against `keys.go` before the brief is written.
