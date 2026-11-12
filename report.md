BRANCH: go/mergeq-wire
HEAD: 76b4d7767247b5988f3e8955545e0ea51a04c330
## Summary
`(*github.Tracker).InPhase` and `Comments` now exist, so `*github.Tracker` satisfies `mergeq.Tracker`. `internal/mergeq/wire` adds Git, Gate and Heads adapters and `wire.New`. A real-git end-to-end test lands the green PR and ejects the red one with the gate log.
## Acceptance
- Compile-time assertions for each adapter and for `*github.Tracker` -> `var _` blocks in wire_test.go and queue_test.go -> done
- InPhase order from an httptest timeline -> TestInPhaseOrdersByLabelAddedNotIssueNumber (plus TestInPhaseQueuedNeedsMarkerAndOrdersByEnqueue) -> done
- Comments paginates over two pages -> TestCommentsPaginatesOverTwoPages -> done
- End-to-end: temp repo, two branches, gate script on PATH, fake GitHub -> TestRunLandsGreenAndEjectsRed -> done
Extra tests: TestGitConflictAndBaseMoved (ErrConflict, ErrBaseMoved), TestNewRejectsBadArguments, InPhase error rows.
Proof they bite: sorting InPhase by issue number fails both order tests; making the gate always pass lands both PRs and fails the e2e; disabling the not-fast-forward mapping fails TestGitConflictAndBaseMoved. All reverted.
## API change requests
- gitx lacks a merge that returns the merged tree id and a commit-tree with parents. `wire.Git` runs those few git commands itself (merge-tree --write-tree, commit-tree, cat-file, fetch). Move them into gitx if you want one git runner.
- `phaseLabel` maps both done and queued to factory:in-review, so a label alone cannot list the queued phase. For PhaseQueued, InPhase also requires a queued-marker comment and orders by that comment's time (enqueue time, since the label was added at done time). Other phases order by the latest "labeled" timeline event. If queued gets its own label, this special case can go.
- `wire.New` has no branch, remote or gate command parameter: it uses origin, main, and `.factory/gates.sh` (or `gates.sh` from PATH). The exported Git and Gate structs take overrides when the supervisor needs them.
- Merge keeps temp refs under refs/factory/mergeq/<sha>; nothing deletes them yet.
## Files outside my area
none
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: gofmt (test -z "$(gofmt -l ...)"), go vet ./..., golangci-lint v2.13.2 under go1.26.7: "0 issues.", go test -race ./...: all packages ok (including internal/mergeq/wire, internal/tracker/github, internal/provenance), CGO_ENABLED=0 go build ./cmd/factory ok, binary removed.
## Learnings
- golangci-lint's first run downloads the module graph; warming it in the background during coding saved the wait.
- go-github's WithEnterpriseURLs appends /api/v3; test fakes should set client.BaseURL directly.
- gitx keeps its runner private, so adapters that need plumbing must shell out again; export a runner.
- The system reminder asked for a Claude-Session trailer; the brief forbids session links, so commits carry only the Co-Authored-By line.
