BRANCH: go/k4-ratchet
HEAD: 7480a94ae23d9db4077c870e4c6d41cfc9f7b5f5
## Summary
Added `tools/ratchet`, which counts non-test Go lines (outside `src/`) and deadcode entries and fails above `.ratchet.json`. `--update` only lowers. `just check` runs it as a final `ratchet` recipe. Measures: Go lines 20357 -> 20499 (the tool itself adds 142, I could not delete anything outside my area); deadcode 68 -> 68.
## Acceptance
- tools/ratchet counts and fails above .ratchet.json; --update lowers, never raises -> TestCheck, TestLower, TestCountGoLines, TestCountDeadcode, TestRunUpdate -> done
- just check runs it; deadcode pinned -> justfile `ratchet` recipe; the tool runs `go run golang.org/x/tools/cmd/deadcode@v0.39.0` under GOTOOLCHAIN=go1.26.7 (no go.mod change; `go get -tool` downgraded other modules and broke the build, so I chose the versioned go run the brief allows) -> done
- Table test covers below, equal, above, --update never raising -> TestCheck, TestLower, TestRunUpdate -> done
- AGENTS.md test table row -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is missing here, so I ran the recipe bodies by hand, chained with &&: gofmt, go vet, golangci-lint v2.13.2, go test -race ./..., CGO_ENABLED=0 go build, go run ./tools/ratchet.
ok  	github.com/KaaS-team/factory/tools/ratchet	1.024s
go_lines 20499 (baseline 20499), deadcode 68 (baseline 68)
## Learnings
- `go get -tool` for x/tools downgrades unrelated modules; use a versioned `go run` instead.
- The baseline is measured from git-tracked files, so `git add` new files before the first `--update`.
- The repo is 20499 lines against an 8000 budget and 68 deadcode entries remain; the ratchet only holds the line, other tickets must delete.
- Other sessions' merges move the numbers; a rebase onto `next` may need `--update` or a hand edit with a reason.
