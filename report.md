BRANCH: go/k4-meter-thread
HEAD: 37ee9ab454178c7f4342ef66770c41b8d96f49e7
## Summary
`api.Thread` is now the optional spend-comment interface (meter.Thread is an alias), and Linear and Jira implement it with the sealed `<!-- factory:spend ` comment, updated in place. The porttest prune found nothing to delete: every fake method is used by a test, so that acceptance line is only partly met (see Acceptance).
## Acceptance
- Linear and Jira round-trip the spend comment against an httptest.Server (write, read back, update in place, no duplicate) -> linear.TestSpendCommentRoundTrip, jira.TestSpendCommentRoundTrip (plus vendorkit.TestDecodeBody, porttest TestTrackerSpendCommentIsOneEditedInPlace) -> done. Both fail when Put always creates a comment; a stranger's forged footer is neither read nor overwritten.
- porttest has zero deadcode entries; every remaining fake is used -> blocked in part. The brief's command (no `-test`) lists 34 porttest entries before and 36 after, because porttest is used only from tests. Deleting them would break 21 test files. With `-test`, deadcode reports 0 entries for the whole repo before and after, so no fake is unused. The 2 added entries are the new SpendComment/PutSpendComment fake methods, which the ticket asks for.
## Measures
- Non-test Go lines: 20357 before, 20504 after (+147: DecodeBody, two spend implementations, fake).
- Deadcode (brief's command): 68 before, 70 after; the only change is the 2 porttest lines. With `-test`: 0 before, 0 after.
## API change requests
none (added api.Thread as the ticket allows)
## Files outside my area
- internal/meter/thread.go: the interface body became `type Thread = api.Thread`, so core and github keep compiling and the duplicate definition is gone.
- internal/tracker/vendorkit/codec.go and codec_test.go: added `DecodeBody` and `SpendMarker`. Go had only EncodeBody, and read-back needs the seal check (ports decodeBody from src/adapters/trackers/kit.ts).
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l clean, go vet clean, golangci-lint v2.13.2 prints `0 issues.`, `go test -race ./...` had no failures, `CGO_ENABLED=0 go build ./cmd/factory` printed BUILD_OK.
## Learnings
- The "zero deadcode in porttest" criterion cannot hold with the plain deadcode command; the brief should say `-test` or drop it.
- go test -race ./... plus lint runs over 2 minutes, so it needs a background run.
- Go had no vendorkit decoder, so any "read back" ticket for Linear or Jira needs vendorkit in its area.
