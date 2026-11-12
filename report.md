BRANCH: go/local-route
HEAD: 7a3b7a886685613ec6e01fad9722242fc3e2e809
## Summary
Added `pick.LocalOnly` and `pick.RefillRouted`, which routes tickets with a `.github/workflows/**` file to local or skips them with `needs local dispatcher`. Added a test that a `dispatch/local` worktree can push a workflow file.
## Acceptance
- Table test: workflow file cloud only -> skipped, local fallback -> routed local, normal file -> cloud -> TestRefillRoutedTable -> done
- Glob edge cases (`.github/workflows` itself, nested, `.github/other`) -> TestLocalOnlyGlobEdges -> done
- Reason appears in pick's output for the board -> Result.Skipped[].Reason == ReasonNeedsLocal, asserted in TestRefillRoutedTable and TestRefillRoutedSkipHoldsNoSlotAndBlocksDependents -> done
- dispatch/local can push a workflow file in a temp repo -> TestLocalWorktreeCanPushAWorkflowFile -> done (passed first time because git already works; proved it bites by removing the push, test went red, reverted)
## API change requests
`internal/reconcile/decide.go:166` still calls `pick.Refill`, which does no routing. It should call `pick.RefillRouted` with `Options{Dispatcher, LocalFallback}` (config has `dispatcher` but no `local_fallback` key yet) and show `Result.Skipped` on the board. No change to internal/api needed.
## Files outside my area
none
## Gate evidence
`just` not installed; ran the recipe bodies by hand: gofmt (`test -z "$(gofmt -l .)"`) clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok (last line `ok  github.com/KaaS-team/factory/packs`), `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK, binary removed.
## Learnings
- The first golangci-lint run took several minutes to download modules; the cloud image should pre-warm the module cache.
- A parent entry like `.github` is not treated as local-only (the glob is `.github/workflows/**`), so a ticket listing the whole `.github` dir still goes to cloud.
