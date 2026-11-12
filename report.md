BRANCH: go/workflows-sustain-design
HEAD: d288a8306de3637fbeddd0416129fd87e92ba708
## Summary
Added `packs/workflows/sustain-retest.yml` and `design-to-pr.yml`, both loading through `internal/graph` with fresh-session verify nodes, plus tests. Sustain's report template is the report node's prompt.
## Acceptance
- Both files load with no unknown keys or template vars -> TestAllPacksLoadThroughGraph (renamed from TestSevenPacksLoadThroughGraph, wantPacks extended), TestEverySkillExists, TestEveryNodeNamesTierAndBudget -> done
- Verify node in each is a fresh session -> TestNewPacksFreshSessionVerify -> done
- Sustain report template has no model, token or cost placeholder -> TestSustainReportTemplateHasNoRunFigures -> done
## API change requests
none
## Files outside my area
- packs/packs_test.go: added the two names to wantPacks and renamed one test, as the ticket allows ("add the cases to the existing load-all-workflows test").
- packs/sustain_design_test.go: new test file (not under workflows/).
## Gate evidence
just is missing; ran the recipe bodies by hand: gofmt (test -z), go vet, golangci-lint v2.13.2 ("0 issues."), go test -race ./... (all ok), CGO_ENABLED=0 go build ./cmd/factory (binary removed).
Tests passed on first run, so I broke the code once: a "token cost" phrase in the report prompt failed TestSustainReportTemplateHasNoRunFigures; turning design-to-pr's verify into a plain agent failed TestNewPacksFreshSessionVerify. Both reverted.
## Learnings
- Assumptions not checkable from here: the `auditor reaudit --json` flags beyond the ticket's shape, and the repo config shape (I used .factory/config.json with solutions[].name and .eval, read with jq) and .factory/visual-check.sh. Confirm with the owners.
- The verify node in sustain-retest is an addition so the "verify in each" criterion holds; the ticket's design listed none.
- A fresh cloud image should ship just; the lint run needs a background job.
