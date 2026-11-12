BRANCH: go/docs
HEAD: 36382dc0c1fd8382e1904630bf5c089dd2010c3b
## Summary
Added internal/docgen (CLI and Config renderers), a committed docs/config.md with a freshness test, and a v9 README (82 lines). `just` is not installed; I ran the recipe bodies by hand.
## Acceptance
- docgen.CLI on a sample root matches a golden -> TestCLIMatchesGolden -> done (bites: removing flag rendering turned it red)
- docs/config.md freshness test fails after a key is added without regenerating -> TestConfigFreshness -> done (shown once: added key zz_new, got "docs/config.md is stale", then reverted)
- README under 120 lines, no em dashes, no model name -> TestREADME -> done
## API change requests
none
## Files outside my area
- internal/config/describe.go (new): exports Describe() because the key table (specs) is unexported and docgen needs type, default and org rule.
## Gate evidence
gofmt clean, go vet ok, golangci-lint v2.13.2: "0 issues.", go test -race ./...: all ok, CGO_ENABLED=0 go build ./cmd/factory ok (binary removed).
## Learnings
- README mentions `factory init`, which has no command in the tree yet (only first-run exists); the factory-install session must add it.
- Supervisor still needs the CLI freshness test in cmd/factory using docgen.CLI(newRoot()) and a docs/cli.md.
- Lint took a few minutes the first time; backgrounding it worked.
