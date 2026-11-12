BRANCH: go/k7-assert-kit
HEAD: 247445766059bab6e38a0d04bf2e9ece8c783fbd
## Summary
New `internal/eval/assert/` package: a deterministic, model-free assertion kit ported from promptfoo@4f67101 (MIT) with its names and its weighted scorecard aggregation. It is not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- is-refusal (with inverse), contains, regex, json-valid, cost, latency, promptfoo-compatible names -> TestAssertionsOneFailingAndOnePassingCase, TestIsRefusal, TestAssertionErrors, TestCostMetricOnlyReportsTheCost -> done (json-valid is an alias of promptfoo's is-json; the schema argument of is-json is not ported, syntax only; regex is Go RE2, so no lookaround or backreferences; contains normalizeUnicode not ported)
- weight, threshold, named metric, assert-set aggregation, weight 0 is measure only -> TestScorecardAggregation, TestZeroWeightMetricCountsAsWeightOneInItsMetric, TestAssertSet, TestNonFiniteWeightFailsAggregation, TestZeroWeightAssertionNeverFailsTheTest, TestEvaluateReturnsAssertionErrors -> done (token accounting, guardrail and custom scoring function not ported)
- tool-used, tool-sequence, step-count over our tool-call event log -> same table test (rows "tool-*", "step-count*") -> done. Our log is `[]ToolCall{Name}` defined in the package, since no Go tool-call event type exists in `internal/api`; names match as case-blind globs like promptfoo. Promptfoo names `trajectory:tool-used` etc. work, short names are aliases. Args matching and goal-success (model judged) are left out.
- Header and NOTICE record SHA and MIT -> `// Ported from` first line in refusal.go, assert.go, score.go, trace.go; `## promptfoo/promptfoo@4f67101...` section in THIRD_PARTY_NOTICES.md; internal/provenance test passes -> done
- One failing case per assertion, no model call -> table rows above; the package has no network or model dependency -> done
- Bite-check -> each fix reverted once by sed mutation, test went red: refusal provider-flag/transform guard, empty-is-refusal, refusal inverse, regex, json inverse, cost bound (needed an added boundary row), latency, zero-weight pass, zero-weight metric, threshold override, weights, finite check, set weight, case-blind glob, in-order sequence, tool-used default min (needed an added row), trace inverse, word boundary (needed an added row), apostrophe normalisation -> done
- Left out: upstream's separate "No value provided" refusal reason for a nil output (Go has no nil/empty split, both give "Empty response treated as refusal", same verdict).
## API change requests
- Nothing in `cmd/factory` or `internal/eval` calls `assert.Evaluate` yet, so deadcode lists the 24 new exports. Wiring needs a change in `internal/eval` (a Fixture or scorecard field holding `[]assert.Assertion`, filled from the session's tool-call events and `api.Usage`), outside my area. I did not do it.
- `internal/api` has no tool-call event type; `assert.ToolCall` should be fed from the session log by whoever owns that.
## Files outside my area
- THIRD_PARTY_NOTICES.md: new section required by the ticket and the provenance test.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt -l (empty), go vet ./..., golangci-lint v2.13.2 run ./... (0 issues after fixing one S1011), go test -race ./... (all ok, last lines `ok .../pkg/agentrun`, `ok .../pkg/sandbox`), CGO_ENABLED=0 go build ./cmd/factory (ok).
Measures: non-test Go lines before 20980, after 21736 (+756, of which about 160 are the refusal phrase table, which is the ported data). Deadcode lines before 75, after 99 (the 24 new ones are all in eval/assert, see API change requests).
## Learnings
- `just` is missing in the cloud image; bake it in or put the recipes in a script.
- golangci-lint via `go run` downloads for minutes the first time; cache it in the image.
- A new package with no caller always raises deadcode; a ticket for a library should name its consumer, or the budget line cannot be met.
