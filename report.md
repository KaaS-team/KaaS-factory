BRANCH: go/graph-keys
HEAD: c133f16fbbeb2dc9a9c8f0a7602c48d42d699ad8
## Summary
Graph nodes now take `tier` (small, large), `budget` (token int) and `skills`; all seven pack workflows use them and the top-level `agents:` maps are gone. The old map still loads and comes back as `Graph.Warnings`. Node prompt template errors carry the file line.
## Acceptance
- Loading a node with each new key sets it; a wrong type fails naming key and line -> TestNodeAgentKeys, TestNodeKeyErrorLineInMarkdown -> done
- Every shipped workflow loads with no `agents:` map; old form loads with a warning -> packs TestEveryNodeNamesTierAndBudget, packs TestOldAgentsMapStillLoads, graph TestOldAgentsMapStillLoadsWithWarning -> done
- Unknown template variable error names variable, step and line (golden) -> TestUnknownVariableErrorGolden (testdata/unknown-var-yaml.golden, unknown-var-markdown.golden) -> done
- Existing 18-workflow test and packs/packs_test.go still pass -> TestEveryExistingWorkflowLoads, packs tests (packs_test.go edited to read node keys) -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` missing; ran the recipe bodies by hand: `test -z "$(gofmt -l .)"` ok, `go vet ./...` ok, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok (no FAIL), `CGO_ENABLED=0 go build ./cmd/factory` ok (binary removed).
Bite checks: removing the `promptLine++` for block scalars failed the golden; adding an `agents:` map back to bugfix.yml failed the packs test. Both reverted.
## Learnings
- The brief's tier/budget (small/large, tokens) differ from the old map (light/standard/deep/none, turns+minutes). Decisions I made: light -> small, standard and deep -> large; budget = old turns x 10000 tokens (a placeholder, please confirm real numbers); check steps carry no keys (tier on a non-agent step is an error); the old map maps tiers the same way and drops its budget.
- Old-map entries naming no step are an error; a node key wins over the old map.
- A plain (non-block) prompt scalar reports its own line; multi-line quoted scalars report the first line only.
- Template parse errors (unclosed `{{`) still have no line; only unknown-variable errors do.
- Cloud image: first `go test -race ./...` downloads the module graph and exceeds 120 s; run it in the background.
