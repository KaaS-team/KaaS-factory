BRANCH: go/k11-graph-checkpoint
HEAD: 61b86892d1bfae6b6044bdaec461a141ce618e69
## Summary
Ported the langgraph checkpoint-sqlite `checkpoints` and `writes` tables to a new `internal/graph/checkpoint` package, and hooked it into the stage engine in `internal/core`. The engine now saves a checkpoint after every step plus the finished-node result before the graph moves on, so a restart resumes at the unfinished node. The store is not reachable from `cmd/factory` until the wiring below lands.
## Acceptance
- Tables `checkpoints` and `writes` with the upstream key shape -> `TestPutChainsParentsPerThread`, `TestWritesAreKeyedByTaskAndIndex`, `TestStateSurvivesReopen` (`internal/graph/checkpoint`) -> done
- Kill mid-step, restart, re-run only unfinished tasks -> `TestRestartDoesNotRedispatchFinishedNodes` (restart dispatches `build` attempt 2, not `plan`; the no-checkpoint row shows the old behaviour of starting at `plan`) and `TestRestartAppliesSavedResultOfFinishedNode` (`internal/core`) -> done
- Finished tasks are not re-dispatched -> same two tests -> done
- Tickets 2 and 3 (interrupt/resume, AES-GCM wrapper, prune, conformance suite) -> not started: the brief names only ticket #1 as mine.
- Wiring reachable from `cmd/factory` -> blocked: needs an edit in `cmd/`, which is outside my area (see API change requests). Deadcode lists `Open`, `Store.Close`, `Store.Put`, `Store.PutWrites` and `Store.Latest` as unreachable until then.
Bite-checks (each fix reverted once, test went red): no restore in `stageOf` -> restart dispatched `plan` attempt 1; saved result ignored in `advance` -> base 1 instead of 2; no save on advance -> both restart tests failed; `INSERT OR REPLACE` removed from `PutWrites` -> `TestWritesAreKeyedByTaskAndIndex` failed (checked by running it; the exact failing line was not recorded).
Already on the base branch: nothing for checkpoints. `core.stageRun` held a ticket's graph position in memory only, and `advance` returned "not staged" for a ticket after a restart, so a mid-graph ticket was treated as done.
Deviations: one checkpoint per stage step (advance, resume), not per scheduler tick, because the stage state only changes at those points. The `type` column holds "json"; the type/blob split is dropped as the ticket allows.
## API change requests
- `cmd/factory/workflow.go` `stagesFor`: open `checkpoint.Open` on a file next to `dbPath` and set `Stages.Checkpoints`. About 6 lines. Until then `Stages.Checkpoints` is nil and the engine behaves as before.
## Files outside my area
- `internal/core/stage.go`, `internal/core/ports.go`: the hook (stage state restored and saved around `stageOf`, `advance`, `resume`; `stageBrief` takes ctx). `internal/core/stage_checkpoint.go` and its test are new. Core is where the stage engine runs; `internal/graph` has no step runner.
- `THIRD_PARTY_NOTICES.md`: langgraph@a054ed0 section.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand: `gofmt -l .` (nothing outside `src/`), `go vet ./...`, golangci-lint v2.13.2 with go1.26.7 (`0 issues.`), `go test -race ./...` (all ok), `CGO_ENABLED=0 go build ./cmd/factory` (`GATE-OK`).
Measures: non-test Go lines (excluding `src/`) 21418 -> 21683 (+265 including the untracked-file count; the package and hook, no deletions). Deadcode lines 70 -> 75 (the five checkpoint store functions above).
## Learnings
- No `just` in the cloud image: the setup step should install it or the brief should list the recipe bodies.
- The lint run downloads many modules and exceeds the 120s foreground timeout; run it in the background.
- A brief that bans editing `cmd/` and also demands reachability from `cmd/factory` conflicts for any new store; the brief should name the wiring file or allow a one-line edit there.
- The base branch has no step runner in `internal/graph`; the engine is in `internal/core/stage.go`, which the area line should say.
