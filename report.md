BRANCH: go/k10-traces
HEAD: e39c92ae9e0d2ce49ff015b465b579951891465d
## Summary
Added `internal/trace` (span schema for agent, tool, handoff, gate and generation, a 4-method `Sink`, a JSONL sink and file sink, and a validating reader). `eval` now writes `<scorecard>.trace.jsonl` next to each scorecard and has an `eval replay <file>` command.
## Acceptance
- One task run writes a trace file -> TestEvalRunWritesTraceAndReplayReadsIt, TestJSONLSinkRoundTrip, TestFileSinkAndConcurrentWrites -> done
- Eval replay reads it -> TestEvalRunWritesTraceAndReplayReadsIt, TestReplayRejectsBadFile -> done
- Gate spans carry a triggered flag -> TestRunGateSpansCarryTriggered, TestReadRejects (gate without flag) -> done
- Bite-check: dropping the gate-flag validation failed TestReadRejects; making the flag always false failed TestRunGateSpansCarryTriggered and the run/replay test; removing WithSink from the command failed the run/replay test.
- Left out: tool and handoff spans are in the schema but nothing emits them yet (no caller exists; adding one would be unreachable code). Generation spans carry token counts only, no model name. Tickets #1 and #3 belong to other sessions.
## API change requests
none
## Files outside my area
- `docs/cli-reference.md`: regenerated (UPDATE_GOLDEN=1) because `eval replay` is a new command; `TestCLIReferenceFresh` fails otherwise.
- `THIRD_PARTY_NOTICES.md`: new `openai/openai-agents-python@64fbde5` section (provenance test). Design only; no text copied.
- `internal/eval/eval.go`, `command.go`: the smallest hook (variadic `RunOption`, so existing callers are unchanged).
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt -l, go vet, golangci-lint v2.13.2, go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory.
Last lines: `0 issues.` then `GATE-OK`.
Measures: non-test Go lines 21276 -> 21569 (+293). Deadcode 70 -> 70.
## Learnings
- `just` is absent in cloud sessions; the brief's by-hand fallback works but exceeds the 120s tool timeout, so run it in the background and watch for the `GATE-OK` line.
- Piping the gate through `grep -v` hid the success line from a quick look; end the chain with an explicit marker and grep for it.
