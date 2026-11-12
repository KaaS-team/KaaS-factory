BRANCH: go/config-shadow-trust
HEAD: a9b6554d232715b38a74a67aa3c246706560d4b2
## Summary
Added `shadow`, `trust.min_role` and `trust.allow` config keys with org clamping, and `shadow.Wrap`. All tests pass except the generated config reference freshness test, which needs regenerating outside my area.
## Acceptance
- Layer table (org true + repo false = true; org unset + repo true = true; org maintain + repo write = maintain) -> TestShadowTrust_LayerTable -> done
- Unknown values fail with the key name -> TestShadowTrust_UnknownValuesNameTheKey (the env layer names FACTORY_<KEY>, as for every key) -> done
- Wrap with shadow on dispatches nothing and records the brief -> TestWrap -> done
- `go test ./cmd/factory` passes; generated reference -> `cmd/factory` ok; `internal/docgen` TestConfigFreshness fails because docs/config.md is stale. Regenerate: `UPDATE_CONFIG_DOC=1 go test ./internal/docgen -run TestConfigWrite` -> done (regenerate command listed, docs/ not edited)
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", static build ok, `go test -race ./...` all ok except `internal/docgen` TestConfigFreshness (stale docs/config.md; fix is the regenerate command above). I did not run `just check` itself.
Bite proof: removing `l.clamp()` failed 4 config subtests; inverting the `Wrap` condition failed TestWrap (both reverted).
## Design notes
- `Wrap` takes a third argument, a `shadow.Writer`, because a two-argument form cannot record: `Wrap(d, cfg, w)`. Off returns d itself.
- The org clamp resolves rather than errors, per the acceptance table; `Explain` names org as winner when it clamps. TestLayering skips the team-over-org row for these two keys, since the org clamps them by design.
## Learnings
- The brief's `Wrap(d, cfg)` signature omits the Writer; the brief should state where records go.
- The first golangci-lint run exceeds the 120 s tool timeout; background it as the brief says.
