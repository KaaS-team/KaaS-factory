BRANCH: go/k10-ctx-category
HEAD: 84d6f6db239aa410ecbb9851e4cf214ba4724cac
## Summary
Ported zoekt `index/file_category.go` as `internal/packs/category.go` (pure Go via go-enry v2.9.6, built with CGO_ENABLED=0), with a local `File` struct in place of `Document`. The pack-builder hook is blocked: the Go tree has no context pack builder.
## Acceptance
- File category copied from index/file_category.go@9e78667 with Apache header -> TestDetermineFileCategory (9 rows, every branch) -> done. Header is `// Ported from sourcegraph/zoekt@9e78667 index/file_category.go`; notices section added; provenance test passes. Encode/decode and rank flags dropped as unused.
- Pack builder excludes or ranks low those categories -> none -> blocked. `internal/packs` is the lockfile package. The builder is still TS (`src/context.ts`, frozen) and Go only receives a ready `ContextPack` string (`internal/dispatch/local/preset.go`). `FileCategory.LowPriority()` is ready for a future builder. Until one exists the new code is unreachable from `cmd/factory` (deadcode will list it).
- Eval fixture shows pack token count before and after -> none -> blocked, no builder to measure.
- No new CGO -> `CGO_ENABLED=0 go build ./cmd/factory` succeeded -> done.
- Bite-check: replaced the IsTest branch with `case false:`; TestDetermineFileCategory failed; restored.
## API change requests
none
## Files outside my area
- `go.mod`, `go.sum`: go-enry v2.9.6 (the ticket names the port's dependency); `go mod tidy` run.
- `THIRD_PARTY_NOTICES.md`: required zoekt section.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l .` clean, `go vet ./...` clean, `go test ./...` no failures, `go test -race` on packs and provenance ok, static build ok. golangci-lint and the deadcode run were NOT run (did not fetch them). Not a full `just check`.
Non-test Go lines: after 21342 (before 21276 per the brief; +66 for category.go). Deadcode before/after: not measured.
## Learnings
- Ticket assumed a Go pack builder in `internal/packs`; it does not exist. Tickets should name the real hook file.
- `just` missing in cloud image; install it so the gate runs as written.
