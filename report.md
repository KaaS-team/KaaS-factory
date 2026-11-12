BRANCH: go/k6-replay
HEAD: a1ac3f446fe7c1f9388af0b025fea72f9c74d7bc
## Summary
Added `internal/eval/replay`: a replay provider (`Replayer`, `Open`, `Recorder`) and a `Stabilize` output scrubber, ported from dagger `core/llm_recording.go` and `util/scrub/scrub.go` at 835b0ef (Apache-2.0). Nothing calls it yet: wiring needs `internal/eval` or `cmd/`, which are outside my area.
## Acceptance
- A recorded fixture replays with 0 provider calls -> TestReplayMakesNoProviderCalls -> done
- Divergence error names the first differing message index, diff never prints media bytes -> TestReplayDivergence (4 rows), TestReplayExhausted, TestReplaySystemPromptTrim -> done
- Scrub rules cover digests, sizes, timings and ports -> TestStabilizeRules (19 rows), TestStabilizeIsIdempotent -> done
- CI runs replay by default and live only on re-record -> TestRerecordCallsLiveOnceThenReplays, TestOpenReplayMissingFile, TestRerecordFromEnv -> partial: `Open(path, rerecord, live)` and `RerecordFromEnv` (FACTORY_EVAL_RERECORD) exist; the CI and `factory eval` call sites are not wired (outside area), so the default is not yet enforced in CI.
- Bite-check: reverted or broke each in turn and saw its test fail: replay calling live, system-prompt trim, role check, media check, index off by one, stabilize in compare, media redaction, and the digest, size, duration, localhost-port and port-word rules. Not bitten separately: the sha256/xxh3 split, date and time rows.
- Left out: other dagger tickets (#1 cache store, #3 lockfile/patternmatcher) belong to other sessions. go-cmp not added; the diff is a small hand-written line diff. Upstream `renderMessagesForModel` and `ValidateLLMContent` do not exist here, so the replayer compares recorded messages directly and Decode checks block kinds itself. Tool calls (name and arguments) are compared in addition to upstream's text.
## Measures
- Non-test Go lines: 20357 before, 20712 after (+355).
- Deadcode lines: 68 before, 87 after (+19, all in `replay`, unreachable until wired).
- Both exceed "nothing unreachable from cmd/factory"; the fix is one call site in `internal/eval` or `cmd/`, which I did not make.
## API change requests
none
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: the new `dagger/dagger@835b0ef...` section the provenance test requires.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand with GOTOOLCHAIN=auto: `gofmt -l` (clean), `go vet ./...` (clean), golangci-lint v2.13.2 on `./internal/eval/...` only (0 issues; not run repo-wide), `go test -race ./...` (all packages ok, no failures), `CGO_ENABLED=0 go build ./cmd/factory` (BUILD_OK).
## Learnings
- `just` is missing in the cloud image; the gate recipes must be runnable without it.
- Repo-wide golangci-lint downloads many modules; run it on the touched packages for the inner loop.
- A brief demanding reachability from `cmd/factory` while forbidding edits to `cmd/` and eval files makes it impossible for a new package; the ticket should name the wiring slice.
- The system attribution trailer conflicts with the brief's no-session-trailer rule; I followed the brief.
