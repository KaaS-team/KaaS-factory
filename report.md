BRANCH: go/k8-safe-outputs
HEAD: fbaae737fb249cedcd3da88614edeee93d5958f7
## Summary
Added `internal/tracker/safeout`: tolerant NDJSON intake, per-verb policy, an apply stage behind narrow Writer and Ledger interfaces, and a credential-free agent env filter. It is original code in the gh-aw shape, so no file carries a "Ported from" header and THIRD_PARTY_NOTICES.md is unchanged. The package is not yet reachable from `cmd/factory`.
## Acceptance
- Per-verb policy (max positive or -1, allowed labels, title prefix, expires, staged) -> TestPolicyRows, TestMaxRule, TestExpiresStampsCreatedIssue -> done
- Invalid lines dropped and reported with line number, valid lines still applied -> TestInvalidLinesDroppedWithLineNumberValidStillApplied -> done
- Each item and outcome recorded in the spend/audit ledger -> TestLedgerRecordsEveryItemAndOutcome (via the Ledger interface; no concrete adapter to the real spend ledger) -> partly done
- `staged` logs without writing -> TestPolicyRows/staged -> done
- No tracker token in agent session env -> TestNoTrackerTokenInAgentEnv (tests `AgentEnv`; nothing calls it at dispatch yet) -> partly done
## Bite-check
Reverting each fix once made its test fail: max, staged, labels, title prefix, expires, ValidMax, env filter, bad-line drop. The ledger record mutation first showed no failure because it did not compile; after fixing the mutation, it failed one test.
## Measures
Non-test Go lines: 21276 before, 21523 after (+247). Deadcode lines: 70 before, 83 after (+13, all the new package, unreachable from `cmd/factory`).
## Left out
- Wiring into `cmd/factory` and a concrete Ledger/Writer adapter over the trackers: outside my area, so the package is dead code until another session does it.
- Using the sanitizer from ticket 1: not in this area, so Apply takes an optional `sanitize func(string) string`.
- Per-type token: dropped, since the apply stage holds the one credential.
- JSON repair helpers from gh-aw: not ported; invalid lines are dropped and reported.
- `just` is missing, so I ran the recipe parts by hand: gofmt, vet, golangci-lint (0 issues) and `go test -race` on the new package and provenance only. The full `go test ./...` and the static build were not run, and neither was the whole-repo `just check`.
## API change requests
Add a `safeout`-shaped write port (Comment, AddLabels, CreateIssue) to the tracker adapters, and a Ledger adapter over the spend comment, then call `safeout.AgentEnv` in the dispatcher.
## Files outside my area
none
## Gate evidence
Package tests only: `ok github.com/KaaS-team/factory/internal/tracker/safeout` under `-race`, and golangci-lint `0 issues.` The full `just check` was not run.
## Learnings
- `just` is absent in cloud sessions; the brief should ship a script with the recipe bodies.
- A bite-check by sed can fail to compile instead of failing a test, so check that the failure is a test failure.
