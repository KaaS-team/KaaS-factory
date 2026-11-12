BRANCH: go/plan-spec
HEAD: 72f20993ba691e49e68f40f475fd596a5452013c
## Summary
Added `plancmd.LocalSpec(bin, repoDir)`, which drafts a spec by running the operator's agent once in plan mode with read-only tools. The spec is validated with the same path `plan` uses, retried once with the validation errors, then returned as an error.
## Acceptance
- Fake `claude` on PATH with a valid stream-json spec makes `plan "goal"` print the DAG -> TestLocalSpecPrintsDAG -> done
- Invalid first, valid second succeeds after one retry; two invalid fail with the errors -> TestLocalSpecRetriesOnceWithErrors, TestLocalSpecTwoInvalidFail -> done
- Child env has no `ANTHROPIC_*` even when the test sets one -> TestLocalSpecEnvHasNoProviderKeys -> done
- Argv comes from `internal/dispatch/local` -> TestLocalSpecArgvFromLocalBuilder (compares every argv element to `local.ClaudeArgv` output) -> done
## API change requests
- `internal/dispatch/local`: export the provider-key env filter (`childEnv`) and a read-only plan mode in `ClaudeArgv`. I copied the filter into `agentEnv` and overwrite the `--tools` and `--permission-mode` values after the builder returns. Both are duplicates to remove once local exports them.
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand. `test -z "$(gofmt -l .)"` passed, then `go vet ./...`, `go test -race ./...` (all packages ok) and `CGO_ENABLED=0 go build -o /dev/null ./cmd/factory` (BUILD_OK). golangci-lint v2.13.2 printed `0 issues.`.
I broke the code three ways to prove the tests bite, then reverted each: one attempt only (retry test red), env filter removed (env test red), permission mode left as dontAsk (argv test red).
## Learnings
- The local argv builder has no read-only mode, so callers patch the argv after the fact. Export a read-only option.
- Fake `claude` scripts must record argv NUL-separated, because prompts are multiline.
- golangci-lint's first run takes about 5 minutes here; start it in the background first.
