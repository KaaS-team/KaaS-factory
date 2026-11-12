BRANCH: go/mergeq
HEAD: 8924ef9713b395930a4c07548f136996e56d3639
## Summary
`internal/mergeq` has a pure `Plan(queue, state) []Action` and a `Runner.Run` that applies it through `Git`, `Gate` and `Store` interfaces defined in the package. It batches PRs (default 4), fast-forwards on green, bisects red batches to the single culprit, and re-tests any PR whose head moved.
## Acceptance
- Plan table test (empty, one green, batch of 4 green is one fast-forward, red then bisect to culprit, head moved, closed while queued) -> TestPlan (one row per branch, plus merged, missing PR, old-base green, inferred red, batch cap, default size) -> done
- Bisect: PR 3 of 8 bad, other 7 land in order, 3 ejected with log tail, at most ceil(log2 8)+1 extra gate runs -> TestRunBisectsToTheCulprit (4 extra runs, limit 4) -> done
- Base never red, property test over random assignments -> TestPropertyBaseNeverRed (300 random cases) -> done
- Restart continues without merging twice -> TestRestartNeverMergesTwice (cancel mid-queue, and crash after fast-forward before Landed) -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand. Golangci-lint v2.13.2 via `go run` reported "0 issues."
```
fmt-ok
vet-ok
ok  	github.com/KaaS-team/factory/cmd/factory	1.012s
?   	github.com/KaaS-team/factory/internal/api	[no test files]
ok  	github.com/KaaS-team/factory/internal/api/porttest	1.014s
ok  	github.com/KaaS-team/factory/internal/mergeq	(cached)
ok  	github.com/KaaS-team/factory/internal/provenance	1.033s
build-ok
```
## Learnings
- I wrote the code before the tests, against the brief's order. I then checked the tests bite by mutating the code (base check, head recheck, prefix choice, inference). One mutant first survived (the pre-land head recheck) until I added TestRunRechecksHeadsBeforeLanding.
- Bisect must pick the shortest known-red prefix and infer red for the remainder after landing the green half. Picking the longest cost 5 extra gate runs instead of 4.
- `just` was missing in the cloud image; the factory's cloud default should install it or the brief should give the commands.
- Restart state lives in the tracker (PR merged or open, queued head); in-memory bisect results are not persisted, so a restart re-tests a full batch. This is safe but costs a gate run.
- Not included: overlap serialisation (ADR 0005) and the per-repo lease (ADR 0003); the supervisor owns both.
