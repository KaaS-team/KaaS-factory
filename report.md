TICKET: m2-k4
NEXT: 292fc04 (origin/next after my last push; tree identical to the previous tip 2932e5d)
## Merged
- go/k4-marker-codec -> 3ba614c (ancestry only, tree unchanged)
- go/k4-observe-parked -> 65081ea (ancestry only, tree unchanged)
- go/k4-test-quality -> 54e4a8a (ancestry only, tree unchanged)
- go/k4-ratchet -> 292fc04 (ancestry only, tree unchanged)
## Skipped
- none
## Already on next
- All four. next already carried each branch as a squash-style commit (51e441b marker-codec, b5876e3 observe-parked, 312d11d test-quality, 6a325c4 ratchet) but none was an ancestor. Every plain merge conflicted only because next had the same change (add/add in tools/ratchet and .ratchet.json; same hunks in tracker.go, thread.go, a2a.go). I merged with `-X ours`; `git diff origin/next` was empty after each, so the content is next's. One exception: marker-codec auto-merged a second copy of `ownBy` in internal/tracker/github/thread.go (build error "ownBy redeclared"); I restored thread.go from HEAD before committing. Ratchet: next's `tools/ratchet` and `.ratchet.json` were kept, nothing in k4-ratchet was missing from next.
## Bite checks
- none: no behaviour added or fixed, so there was no fix line to revert.
## Review notes
- marker-codec, observe-parked, test-quality, ratchet: not re-reviewed line by line; the content was already on next from the earlier reviewed merges. Only the duplicate `ownBy` merge artifact above was noticed.
## Gate evidence
Full `just check` on the first attempt (tip b760060 + merges, tree equal to next): `golangci-lint ... 0 issues.`, `just test build ratchet` rc=0, `go_lines 27037 (baseline 27037), deadcode 165 (baseline 165)`. The push was rejected (next moved), so I redid the merges on 2932e5d and re-ran only fmt, vet, ratchet and the tracker/github, a2a, marker, ratchet tests (all ok; last ratchet line: `go_lines 29679 (baseline 29679), deadcode 228 (baseline 228)`). I did not re-run the whole suite after the retry; the tree equals next's. `go test -race -count=3` on marker, mergeq, meter, tracker/github, store, observe, core, a2a, conformance, pkg/agentrun, tools/ratchet, cmd/factory: all ok.
## Learnings
- `just` was missing; installed with `cargo install just --locked`.
- The golangci-lint on PATH is built with Go 1.25 and fails on this repo's Go 1.26 config. I ran the pinned one: `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`.
- `go mod tidy` made no change.
- git user.name/email were "Claude"/noreply; set to KaaS factory / factory@kaas.team.
