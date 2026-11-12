BRANCH: go/k10-infra-classify
HEAD: 69259c45f7ef0a930540ae56400e22831a011055
## Summary
New `internal/eval/infra` ports SWE-bench's ordered infra-failure signature table (environment and ambiguous tiers) with our sandbox kill, sandbox OOM and rate limit rows. `firstrun.Execute` reads an optional session log through it and words "environment failure" apart from "Tests failed" in the PR body. Advisory only: no run is dropped from any count.
## Acceptance
- Ordered signature table with environment and ambiguous tiers -> TestClassifyTable (incl. order row) -> done
- Advisory only, never drops a run from the denominator -> Classify/Summary are pure text functions; TestPRBodySeparatesEnvironmentFromTestFailure still opens the PR and returns the Result for every row, including an unreadable log -> done
- First-run PR body reports "environment failure" separately from "tests failed" -> TestPRBodySeparatesEnvironmentFromTestFailure, TestSummary -> done
- Signatures for sandbox kill and rate limit -> TestClassifyTable rows "sandbox kill", "sandbox oom", "rate limit 429", "rate limit text" -> done
- Bite-check: removing the sandbox/rate signatures failed those rows; removing the verdict wording and the environment-tier handling each failed TestPRBodySeparatesEnvironmentFromTestFailure.
- Left out: the exact signature text for sandbox kill and OOM is a guess ("sandbox: process killed", "sandbox: out of memory"); pkg/sandbox emits neither string today. Exec.Log is not wired in cmd/ (outside my area), so nothing supplies a log yet.
## API change requests
none. Wiring `Exec.Log` (session log reader) in cmd/factory is wanted from whoever owns cmd.
## Files outside my area
THIRD_PARTY_NOTICES.md: the required SWE-bench/SWE-bench@02e7a74 section.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand. gofmt clean, `go vet ./...` clean, golangci-lint (go1.26.7, v2.13.2) on internal/firstrun and internal/eval: "0 issues." (whole-repo lint not run). `go test -race ./...` and `-tags ee` passed, tail: `ok github.com/KaaS-team/factory/pkg/sandbox 1.322s`, then `BUILD_OK` (CGO_ENABLED=0 build).
Measures: non-test Go lines 21276 -> 21371. Deadcode lines 70 -> 70.
## Learnings
- `just` missing in cloud sessions; the gate takes over 2 minutes so run it in the background from the start.
- The pkg/sandbox failure strings should be a shared constant so signatures cannot drift.
- The repo is over its line budget; this change added 95 lines and deleted none.
