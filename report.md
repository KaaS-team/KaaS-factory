BRANCH: go/k7-otel-sampling
HEAD: 1841042149ad05702cd6036adb215faf22e8823a
## Summary
Added `internal/observe/sampling` with the deterministic sampling port (our domain string), a per-rule rate table, and a gen_ai.usage.* to api.Usage mapper. The new functions are not reachable from `cmd/factory`, because wiring them needs files outside my area.
## Acceptance
- Sampling function ported with a stable-value test across runs -> TestValueIsStableAcrossRuns, TestSample -> done (value pinned from the upstream algorithm run in node with our domain string)
- Observe accepts gen_ai.usage.* attributes and maps them to meter usage types -> TestUsageFromAttrs -> done as a pure function (api.Usage fields; current and legacy key names); not called by any ingestion path, so blocked on reachability
- Judge-eval rate configurable per rule -> TestRatesPerRule, TestRatesRoughlyHonoured -> done as `Rates{Default, Rules}`; no config or eval code reads it yet, so blocked on reachability
- Bite-check: reverting the 53-bit shift, the rate comparison, the output_tokens key, and the per-rule lookup each turned the tests red (4 to 5 failures each).
## API change requests
None. Wiring wanted: the OTLP ingestion path should call `sampling.UsageFromAttrs`, and the eval runner should read `sampling.Rates` from config.
## Files outside my area
THIRD_PARTY_NOTICES.md: langfuse section, required by the provenance test.
## Not done
- attributes.ts key list not ported: its langfuse.* keys include nothing for gen_ai.usage.*, and the ticket's mapping needs OTel names. Nothing from that file was copied, so it has no notice.
- Reachability: `deadcode` reports 5 new unreachable functions (UsageFromAttrs, count, Value, Sample, Rates.Should).
## Measures
- Non-test Go lines (non-src): before 20980, after 20980 (the command counts tracked files only; the new files were untracked when it ran, so ours add about 90).
- Deadcode lines: before 70, after 75.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt -l . (clean), go vet ./... (clean), golangci-lint v2.13.2 (0 issues), go test -race ./... (all ok, no failures), CGO_ENABLED=0 go build ./cmd/factory (BUILD_OK).
## Learnings
- `just` is absent in cloud sessions; the brief should name the fallback commands in one script.
- The reachability rule and the area rule conflict for a new leaf package; the brief should name the wiring owner.
- `go test -race ./...` exceeds the 120s tool timeout; run it in the background.
