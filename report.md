BRANCH: go/k5-sandbox-runsc
HEAD: f310c99aca48fdbb7d7a0de09ab7be4fb4cee106
## Summary
Added an optional gVisor runsc backend in pkg/sandbox (runsc.go). Spec.Backend "runsc" runs `runsc --rootless --network=none --overlay2=all:memory do <argv>` when a runsc matching the pinned sha256 is found; otherwise Command falls back to the existing jail. No Go was copied from upstream, so no notices were needed.
## Acceptance
- optional runsc do backend with the three flags -> TestRunscArgv, TestCommandUsesRunscWhenPinned -> done
- selected by config, falls back to jail when runsc is absent -> TestChooseBackend (6 rows), TestCommandFallsBackToJail -> done at the pkg/sandbox level (Spec.Backend); nothing sets it yet, see API change requests
- eval fixture runs go build, npm ci, git inside it and reports pass/fail and wall time -> TestRunscEval -> partial: it skips here (runsc absent) with a reason; it runs `go version`, `npm --version`, `git --version` and logs pass/fail and time, not a real go build or npm ci
- runsc version and sha256 pinned in the packs lock -> blocked: DefaultRunscPin is empty because I could not fetch a runsc release here to compute a real sha256 (the gVisor URL I tried returned 404), and I did not invent a hash. While it is empty the backend stays off and the jail runs. The packs lock (internal/packs) is outside my area and models fetched files, so the pin lives in a Go var.
Bite-checks (each reverted and seen red): network flag changed -> TestRunscArgv fails; sha compare inverted -> TestChooseBackend fails; runsc branch disabled -> TestCommandUsesRunscWhenPinned fails; unpinned check removed -> TestChooseBackend fails (after tightening its expected reason to "no pin").
Measures: non-test Go lines 20357 -> 20447 (+90). Deadcode lines 68 -> 68.
## API change requests
- internal/config and internal/dispatch/local should set sandbox.Spec.Backend from config (for example key sandbox_backend); the local dispatcher builds the Spec at internal/dispatch/local/local.go:250 and does not set it.
- An operator needs to set DefaultRunscPin (or a config/lock source for it) to a real release sha256.
## Files outside my area
none (pkg/sandbox/sandbox.go edited: Spec.Backend field and Command now delegates to commandFor; there is no separate backend list in the repo, so that is the registration)
## Gate evidence
Run by hand because just is missing: gofmt clean; go vet ok; golangci-lint (go1.26.7, v2.13.2) "0 issues."; go test -race ./... no failures; CGO_ENABLED=0 go build BUILD_OK. just check/fast and the pre-push hook were not run.
## Learnings
- just is not installed in cloud sessions; the factory image should include it.
- The gate takes over 2 minutes; run it in the background from the start.
- The brief refers to a "backend list" that does not exist in pkg/sandbox.
