BRANCH: go/k5-packs-manifest
HEAD: d7999a78cd44a1870ca7cf8b4f492af973fb2854
## Summary
Pack manifests (`pack.yaml`) now take an optional `retry` block, are validated against goose's parameter caps through a bounded read that fails on change or lock-hash mismatch, and accept `paths:` and `keywords:` triggers on skill packs. All three are reachable from `cmd/factory` through `packs run`, `packs match` and `packs verify`.
## Acceptance
- goose #1: failing check re-runs the task up to max_retries -> TestRetryRun/"a failing check re-runs until it passes", "...stops at max_retries and runs on_failure" -> done
- goose #1: passing check ends it -> TestRetryRun/"a passing check ends it after one run" -> done
- goose #1: timeouts default 300 s and 600 s -> TestRetryDefaultTimeouts -> done
- goose #1: stderr capped at 8 KiB (last 8 KiB kept) -> TestRunShellCapsStderrAtTail8KiB -> done
- goose #1: unit tests for pass, fail, timeout -> TestRetryRun subtests incl. "a timed out check is an error, not a pass" -> done
- goose #2: caps 32 params, 200 select options, 128 KiB params -> TestParseManifestCaps (each at and over the cap) -> done
- goose #2: bounded read that fails if the file changed after validation -> TestLoadManifestBoundedRead, TestLoadManifestFailsWhenFileChangesAfterValidation -> done
- goose #2: lock hash mismatch fails the load -> TestLoadManifestLockHash, TestVerifyFailsOnManifestHashMismatch (via `packs verify`) -> done
- openhands #3: skill body injected only on match -> TestSkillBodyInjectedOnlyOnMatch, TestMatchCommandListsTriggeredSkills -> done
- openhands #3: token count per task before and after on 3 fixtures, no pass-rate drop -> TestTriggersCutTokensWithoutDroppingNeededSkills -> blocked in part: it logs a bytes/4 estimate on 3 fixtures and asserts fewer tokens and that every needed skill is still injected (a proxy). There is no eval scorecard in my area and no real agent run, so no real pass rate was measured.
Bite-check: reverted each fix once and the named test went red: params cap, options cap, size cap, changed-file check, lock-hash check, max_retries, default timeout, stderr cap, timeout handling, inject-only-on-match, and the verify manifest wiring. (The changed-file revert first broke the build on an unused import; redone as `&& false` and it failed as expected.)
Left out: goose retry.rs Windows `cmd /C` branch, the `GOOSE_*` env vars, scheduler and tool_monitor pieces (other tickets), the other openhands tickets (other sessions). Goose has no select-option rule beyond the total cap, so none was added. Goose tickets #1 and #2 and openhands #3 went in one commit because manifest.go, command.go and the docs golden change together.
## API change requests
none
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: sections for block/goose@910d084 and OpenHands/software-agent-sdk@10be259 (required by the provenance test).
- `docs/cli-reference.md`: regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory` because `packs run` and `packs match` are new commands (TestCLIReferenceFresh).
## Gate evidence
`just` is not installed here, so I ran its recipes by hand: gofmt -l (empty), go vet ./..., golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7) `0 issues.`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`.
First full run failed only `cmd/factory` TestCLIReferenceFresh (fixed as above). After the fix:
```
ok  	github.com/KaaS-team/factory/cmd/factory	1.748s
ok  	github.com/KaaS-team/factory/internal/packs	(cached)
ok  	github.com/KaaS-team/factory/internal/provenance	1.037s
0 issues.
```
I did not rerun the whole `go test -race ./...` after the doc regeneration, only these three packages. Every other package passed in the first run.
Measures: non-test Go lines (excluding src/) 20357 -> 20861 (+504). Deadcode lines 73 -> 68 (the 68 has no packs entries; I do not know why it fell, nothing of mine removes code). The +504 is over the "prefer deleting" intent: nothing in my area was redundant to delete.
## Learnings
- Tail-ing the gate output hid the failing package; write the full output to a file and grep it.
- A new cobra command changes a generated doc outside the area; the brief should list `docs/cli-reference.md` as a known edit.
- The brief's `openhands` repo name is really `OpenHands/software-agent-sdk`, and `10be259` only exists there.
- `just` missing means hand-running recipes costs minutes; the image should include it.
- `packs/checks/browser/pack.yaml` was the only existing manifest, so "pack manifest" had no Go type; the brief should say so.
