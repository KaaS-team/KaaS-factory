BRANCH: go/k5-preset-rules
HEAD: 1ad769a8a10563ee8f64a6d198fe0eab19e42129
## Summary
The claude preset's allow list is now rendered from an ordered `{action, resource, effect}` ruleset (last match wins) with an Unattended settle rule, ported from opencode core/permission.ts@a1aa513. The argv stays byte-identical (golden test passes).
## Acceptance
- Table-driven tests ported from permission.ts cases -> TestEvaluate, TestSettle (internal/dispatch/local/rules_test.go) -> done
- A preset with no allow rule denies a write -> TestSettle "no allow rule denies a write", TestStageRulesDenyWriteWithoutAllow -> done
- Configured deny beats unattended allow -> TestSettle "configured deny beats unattended allow", "deny on one resource denies all" -> done
- About 100 Go lines or fewer -> rules.go 65 lines, preset.go net +13 (78 total) -> done
- Bite-check: removing the last-match assignment, the deny case, and the unattended-nil branch each turned TestEvaluate/TestSettle red; restored after each. The test-first red was a compile failure (undefined Rule), not a behavioural failure.
- Tickets 2 and 3 (dispatcher auth, SSE spike) belong to other sessions; not done here.
## Measures
- Non-test Go lines: 20357 before, 20435 after (+78; includes the 65-line rules.go).
- Deadcode lines: 68 before, 68 after (Evaluate and Settle are reached through ClaudeArgv).
## API change requests
none
## Files outside my area
- THIRD_PARTY_NOTICES.md: required `## sst/opencode@a1aa513` section for the provenance test.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` -> BUILD_OK.
## Learnings
- `just` missing in the cloud image; the factory default should install it or ship the recipe as a script.
- The race run exceeds the 120s default tool timeout; run it in the background from the start.
- The brief says no Claude-Session trailer while the harness reminder asks for one; I followed the brief and left it out.
- The reminder to add a session trailer conflicts with the brief; I added Co-Authored-By only.
