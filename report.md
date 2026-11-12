BRANCH: go/k6-price
HEAD: ea75bfe2c8714d714ca6caba9b83c7d6f3b67dd3
## Summary
New `internal/meter/price` holds the filtered langfuse catalog (127 Anthropic and OpenAI models, MIT notice and source SHA 2e6d034 in `catalog.json` and `THIRD_PARTY_NOTICES.md`), the ported tier matcher and cost rules, and a refresh diff. `scripts/price-refresh` is a Go command that prints the diff report and exits 1 when anything differs. `Cost` is not yet called from `cmd/factory`, so it shows up as deadcode (see Measures).
## Acceptance
- (a) filtered catalog committed with MIT notice and SHA -> TestEmbeddedCatalog -> done
- (b) cost(model, usage, attrs) returns per-type cost and tier name -> `Catalog.Cost`; TestCost, TestCostMatchesContextAndParsedAttributes, TestFastModeTier, TestCostByCloudAlias -> done
- (c) ported calculateModelUsageCosts.test.ts cases pass -> TestCost (all 7 upstream cases; the prototype-name case is kept as ordinary keys) and TestCostMatchesContextAndParsedAttributes -> done
- (d) unknown model returns explicit unpriced flag, never zero -> TestUnknownModelIsUnpricedNeverZero, plus TestCost rows for empty usage, total-only and custom provided cost -> done
- (e) Claude 5 family entries with source link -> TestEmbeddedCatalog -> done, but not added by hand: the pinned SHA already contains claude-fable-5-2, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 (and more), contrary to the brief's grep. I used upstream's entries rather than invent prices. `overrides.json` is the place for hand entries.
- Ticket 2: diff script, override wins -> TestDiff, TestFilterKeepsOurModelsOnly, scripts/price-refresh TestRun* -> done except "run in CI weekly" -> blocked (needs a `.github/workflows` file, outside my area and cloud sessions cannot push workflows)
- Not done (other sessions' tickets): #3 sampling and OTLP attributes, and the `attributes.ts` and `deterministicSampling.ts` copies.
Bite checks (revert one fix, see its test go red): unpriced flag, unknown total as zero, gt operator, case-insensitive flag, TTL cache fallback, provided total, empty-usage tier selection, catalog override order, override skip in diff changed/removed. The override skip in the Missing list survived at first (no test); I added a row and it now fails.
Precision: prices are held as exact rationals (`math/big`), so no new dependency.
## Measures
- Non-test Go lines: 20357 before, 20957 after (+600; includes the script).
- Deadcode: 68 before, 78 after. All 10 new lines are the price package's `Cost` path, which nothing in `cmd/factory` calls yet. `Load`, `Diff` and the rest are reached through `scripts/price-refresh`.
## API change requests
- Wire `price.Load()` and `Catalog.Cost` into the meter or ledger path when `api.Usage` gets a usage-type map and model name. `api.Usage` today has only four token fields and a `CostUSD` where 0 means unknown, so it cannot carry cache TTL types or the unpriced flag.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: the langfuse section and MIT text the provenance test requires.
## Gate evidence
`just` is not installed here; I ran the recipe bodies by hand: gofmt clean, `go vet ./...` clean, golangci-lint v2.13.2 under go1.26.7 `0 issues.`, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` built. check-prose: 9 file(s), 0 violation(s).
## Learnings
- The brief said the pinned SHA has no Claude 5 entries; it has them. Check the data before planning hand-added rows.
- Go regexp has no lookaround; every catalog pattern compiled as is, but a test now fails if one does not.
- A ported package with no caller in `cmd/` always adds deadcode lines; the brief should name the wiring ticket or allow a `main` under `scripts/` as the root.
- The foreground gate exceeds 120s here; run `go test -race ./...` in the background.
