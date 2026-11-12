BRANCH: go/assemble
HEAD: a647e8fb0f7692ad7bec5566ce5320ee014177fe
## Summary
`cmd/factory` now builds a real `core.Core` from config through per-port tables and mounts board, mcp, dashboard, first-run, upgrade and report; `factory run` starts the core loop. Two ports are still stubs that fail loudly: the merge queue and the observer source. The report command has no ticket source yet.
## Acceptance
- Structure test walks the root tree for all 16 commands -> TestRootCommandTree -> done
- Each tracker and dispatcher name builds; unknown name fails naming allowed values -> TestTrackerTable, TestTrackerErrors, TestDispatcherTable, TestDispatcherErrors -> done (no httptest needed: constructors make no request)
- `factory run --headless` over porttest Deps prints NDJSON from a real core.Core -> TestRunHeadlessRealCore -> done (run now starts the loop when the Control has `Run`; broke that once and the test went red)
- version, doctor, config get never construct a Control -> TestNoControlForPlainCommands -> done (first version passed under a deliberate break, so I changed it to count seam calls; it now fails under the break)
- Doctor table covers dispatcher prerequisite row -> TestDoctorDispatcherPrerequisite -> done (local: claude on PATH, fire: routine id; fail. claude-cloud has no row; broke the row once and the test went red)
## API change requests
- No `observe.Source` implementation over git and GitHub exists, so the observer reads through `notConfiguredSource`, which errors on every call. The loop starts but cannot observe until one lands (one-line swap in `buildDeps`).
- `mergeq.CoreQueue` is still missing. `notConfiguredQueue` returns an error from `Run` as briefed, but `Enqueue` and `Queued` succeed with nothing, so the core can feed it.
- No `report.Source` over store and ledger exists; `report` returns "no ticket source is wired in this build".
- `config` has no adapter keys, so adapters read env: `GITHUB_TOKEN`, `GITHUB_API_URL`, `LINEAR_API_KEY`, `LINEAR_API_URL`, `JIRA_API_TOKEN`, `JIRA_URL`, `CLAUDE_ROUTINES_TOKEN`, `CLAUDE_ROUTINES_URL` (default https://api.anthropic.com), `CLAUDE_ROUTINE_ID`. Linear team and Jira project come from `repo`; ready label is `factory:ready`. They must not start with `FACTORY_`: config rejects unknown `FACTORY_*` variables. Dispatcher names: claude-cloud (routines), fire, local. Defaults are guesses to confirm.
## Files outside my area
none
## Gate evidence
Ran the recipe bodies by hand (`just` is missing): `test -z "$(gofmt -l .)"` ok, `go vet ./...` ok, `go test -race ./...` all packages ok, `CGO_ENABLED=0 go build ./cmd/factory` ok (binary removed), golangci-lint v2.13.2 `0 issues.`
## Learnings
- The system's commit attribution asks for a `Claude-Session:` trailer; the brief forbids it. I amended it out before pushing. The brief and the harness defaults should agree.
- Unknown `FACTORY_*` env vars break config load, which silently dropped the doctor row. Adapter env names need a documented non-FACTORY prefix.
- A "never called" test needs a call counter, not an erroring seam, or a swallowed error hides the regression.
