BRANCH: go/packs
HEAD: ec57beb9a184d9099d22cb6e544e1d4f63a2d134
## Summary
`internal/packs` resolves refs against a git remote, pins them in a JSON `factory.lock` and enforces the licence rule. `internal/graph` loads all 18 existing workflows, and a Symphony `WORKFLOW.md`, into nodes and edges with strict prompt templates.
## Acceptance
- ParseRef round-trips and rejects malformed refs -> TestParseRef -> done
- Resolve records sha and sha256; changed upstream at a pinned sha fails the hash check -> TestResolveRecordsShaAndHash, TestResolvePinnedShaWithChangedUpstreamFailsHashCheck -> done
- AGPL-3.0, GPL-3.0, CC-BY-SA-4.0, NOASSERTION and empty refused; MIT and Apache-2.0 pass -> TestCheckLicence, TestResolveRefusesLicence -> done
- All 18 `.factory/workflows/*` load; golden for planned-to-pr and bug-to-pr -> TestEveryExistingWorkflowLoads, TestGoldenGraphs -> done
- Every entry in blueprint's `upstreams.json` converts into lock entries -> TestFromUpstreamsConvertsEveryEntry (fixture in `internal/packs/testdata/`, 3 repos, 24 files) -> done
- Unknown template variable fails with its name -> TestUnknownVariableInWorkflowPromptNamesTheVariable, TestRender -> done
- Verify node always has FreshSession true -> TestFreshSessionIsForcedOnVerify -> done
## API change requests
none
## Files outside my area
- `go.mod`, `go.sum`: added `gopkg.in/yaml.v3` v3.0.1. The ticket names no dependency but the loaders need a YAML parser. Smallest alternative was a hand-written parser.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l` (clean), `go vet ./...`, `go test -race ./...` (all packages ok), `golangci-lint v2.13.2 run ./...` ("0 issues."), `CGO_ENABLED=0 go build ./cmd/factory` (ok).
```
ok  	github.com/KaaS-team/factory/internal/graph
ok  	github.com/KaaS-team/factory/internal/packs
ok  	github.com/KaaS-team/factory/internal/provenance
BUILD-OK
```
## Learnings
- `just` missing in the cloud image: bake it in, or have the brief ship a `scripts` fallback for the gate.
- The brief's no-`Claude-Session:` rule conflicts with the harness attribution reminder; the brief won. Decide once which wins.
- Design choices to confirm: lock is JSON; the md stages format needs `needs` edges and `approval` becomes a human node; a verify stage in md rejects back to its first `needs`; templates support `{{ a.b | upcase|downcase }}` only, no `{% %}` tags.
- Red-first was proven by mutation for the hash check and fresh-session rules, not for every test; new-package tests cannot "fail" before the package compiles.
