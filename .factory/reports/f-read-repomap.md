# f-read-repomap: repomap.Rank readability

`Rank` was 152 lines. It is now 17 lines that call four stages in `internal/packs/repomap/rank.go`:
`candidates` (file list), `tags` (parse, seeds, defines, refs), `graph` (weighted edges),
`pagerank` (node scores, the old `pageRank` renamed) and `rankOrder` (final tag order).
`render` was already taken in `budget.go`, so the last stage is `rankOrder`.

## Demo commands
```
go test ./internal/packs/repomap -run 'Golden|Stage' -v
```
Output: golden plain, chat and seeded subtests PASS, all stage tests PASS.

## Acceptance
- [x] Golden test passes unchanged before and after. `TestRankGoldenSplitbill` was written and
  recorded on the old code (commit 1), then `rank.go` was refactored and the golden files did not change.
  The repo has only one splitbill seed file, so `testdata/splitbill` adds four small TS files around
  `cents.ts`, and the golden covers plain, chat and seeded runs.
- [x] Each new test fails with the change reverted. Each stage was mutated in turn:
  - weight 50 -> 5 in `graph`: `rank_stages_test.go:73` `CoreEngine edges = map[a.go>core.go:50 ...]`
  - self-loop 0.1 -> 0.2: `rank_stages_test.go:84` `edges = [{l.go l.go 0.2 Lonely}], want [... 0.1 ...]`
  - mentioned-file seed doubled: `rank_stages_test.go:29` `pers = map[a.go:40 core.go:20]`
  - ctx check removed in `tags`: `rank_stages_test.go:44` `want the context error`
  - damping 0.85 -> 0.5 in `pagerank`, chat skip removed, `delete(rest, n)` removed, rest loop removed,
    out-weight changed: `TestRankGoldenSplitbill` `rank output changed`
  - Left out on purpose: the "no refs" fallback in `tags`. The parser also emits a ref for every
    definition, so that branch cannot be reached with Go or TS input; no test claims it.

## Upstreams copied
None new. `rank.go` keeps its existing `Ported from Aider-AI/aider@5dc9490` header.

## Files outside my area
None. No workflow changes needed.

## Gate
`./gate.sh` passes (`just` was not installed). The line ratchet first failed at 42910 against 42880;
I shortened `rank.go` (`setOf`, `slices`, `cmp.Or`) to 42875. Golden and stage tests pass unchanged after that.

## CI
The first CI run failed `check-pr-body` because the PR body linked a Claude session. The body is
fixed. Future PR bodies for this repo must not link a session.
