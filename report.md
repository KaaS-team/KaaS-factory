TICKET: m2-k3a
NEXT: b9e280d78bba1bbdfccbbc96af82adf440ab93cd
## Merged
- go/k3f-state -> ea65642 (empty-content merge, next's side kept; branch is now an ancestor of next)
- go/k3f-graph -> b9e280d (same)
## Skipped
- none
## Already on next
- go/k3f-state -> next carries it as single-parent commit 42501a8 plus later work (k4-marker-codec moved the codec to internal/marker, k4-observe-parked added Parker, k4-core-dispatch). The merge conflicted in 12 files (core.go, ports.go, gitx, observe/commands.go, reconcile/run.go, tracker/github/{thread,marker,marker_test,loop_test}.go, vendorkit/codec*.go) only because next already has the same change evolved; next's side taken, tree identical to origin/next. Tests TestThreadRebuildsStoreAfterDeletion, TestLoopRetryObeysTrustedAuthorsOnly, TestLoopOpensPRWithRenderedBody exist on next; reconcile Config.Backoff exists on next.
- go/k3f-graph -> next carries it as 9d6288e. Conflicts in cmd/factory/control.go, internal/core/{core,ports,stage}.go, same cause; next's side taken. TestRunWalksDefaultGraph, TestRunHonorsRepoWorkflow, KindStage exist on next.
## Bite checks
- none: no behaviour added or fixed (both merges are content-free).
## Review notes
- go/k3f-state, go/k3f-graph: nothing new reaches next from these merges, so the diff was not re-reviewed for new code. Known gaps from the branch reports remain (graph node position lives in memory and resets on restart; Brief has no Tier field).
- NOT MINE, fails on origin/next itself: cmd/factory TestCLIReferenceFresh: "docs/cli-reference.md is stale at line 194; file: ## factory packs run / tree: ## factory packs migrate" (k10-migration-packs added a command without UPDATE_GOLDEN=1 go test ./cmd/factory). It breaks just check on next; left alone, out of scope. The push still went through.
## Gate evidence
just is missing; recipe bodies run by hand with GOTOOLCHAIN=auto (go1.26.0), lint at go1.26.7. gofmt clean, go vet clean (also -tags ee), golangci-lint v2.13.2: 0 issues., go test -race -count=3 on core, reconcile, tracker, gitx, observe, graph, marker, cmd/factory: ok (before next moved). Full go test -race ./...: all ok except TestCLIReferenceFresh (above). Build: BUILD-OK. Ratchet: go_lines 29679 (baseline 29679), deadcode 228 (baseline 228); no .ratchet.json change needed.
## Learnings
- next already holds both branches as single-parent squash commits, so git merge conflicts everywhere; resolve with checkout --ours per file (git rm for files next deleted).
- next moves every few minutes; redo the merges on a fresh origin/next instead of rebasing.
- The brief's trailer names a model; I used "Co-Authored-By: Claude <noreply@anthropic.com>" because the brief also forbids model names in commits.
