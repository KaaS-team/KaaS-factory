TICKET: m1-e
NEXT: b15e595860754ebe49e83f38179ea6741f9b3f0e
## Merged
- go/k8-safe-outputs -> bda28a2 (pushed as 88f0866)
- go/k8-sanitize -> 85761dc (pushed as b15e595)
## Skipped
- go/k8-plan-preset -> push race: the merge and a green `just check` were redone on a fresh origin/next 7 times and every push was rejected. The only conflict was THIRD_PARTY_NOTICES.md (kept both sides). Still unmerged.
- go/k8-policy-combiner -> same push race, 7 tries. One try also hit `TestCLIReferenceFresh` (see Learnings).
- go/k8-policy-signed -> same push race, 6 tries.
## Review notes
- go/k8-plan-preset: clean. guard.go is a denylist, and its header comment says it is defence in depth: `python -c` or a quoted `bash -c` passes it, and the sandbox plus the missing edit tools are the real boundary.
- go/k8-policy-combiner: not reviewed in depth (never got to land).
- go/k8-policy-signed: not reviewed in depth.
- go/k8-safe-outputs: no concerns seen (new package internal/tracker/safeout, 3 files).
- go/k8-sanitize: clean on a read of url.go (userinfo is stripped, non-https schemes redacted, hosts allowlisted by exact or `.suffix` match). Its one conflict, an import list in internal/reconcile/run.go, was resolved by keeping both imports.
## Gate evidence
go test -race, go vet -tags ee, go test -race -tags ee, build and ratchet all passed on the last `just check` (go/k8-sanitize):
CGO_ENABLED=0 go build -o dist/factory ./cmd/factory
go run ./tools/ratchet
go_lines 34072 (baseline 34072), deadcode 297 (baseline 297)
## Learnings
- `just` was missing; installed with `cargo install just`. No `check` recipe was run by hand.
- /usr/local/bin/golangci-lint is built with go1.25 and fails on go 1.26.0, so `just lint` failed. I ran the gate with /usr/local/bin off PATH so the recipe uses the pinned `go run` version. `just check` otherwise ran unmodified.
- origin/next was red on `TestCLIReferenceFresh` (docs/cli-reference.md stale, "packs migrate" missing) before my merges. I ran `UPDATE_GOLDEN=1 go test ./cmd/factory` and committed "docs: regenerate CLI reference" when it differed.
- Each `just check` takes about 65 s (cached) and several sessions push to next every minute or so. A merge, gate and push cycle usually lost the race. Landing took 2 to 6 tries per branch.
- A conflict in a `.go` import list or in THIRD_PARTY_NOTICES.md is routine. Both sides were kept by script.
