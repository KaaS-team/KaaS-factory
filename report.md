BRANCH: go/k5-repomap
HEAD: e4f026fd7c2540fdf274c8b57b86f396de285508
## Summary
Added `internal/packs/repomap`, a Go port of aider's repomap.py ranking (personalised PageRank, identifier weights) and token-budget binary search, with a mtime-keyed tag cache and a `factory repomap` command. go-tree-sitter needs CGO, so Go files use go/parser and ts/js/py use regex tag queries; the binary stays CGO_ENABLED=0.
## Acceptance
- (a) parse go, ts, py with .scm queries carrying attribution -> TestParseDefinitions, TestParseUnknownExtensionHasNoTags, TestParseBrokenGoIsNotFatal -> blocked in part: go/ts/py parse is done, but with go/parser and regex, not go-tree-sitter and .scm files (CGO). No .scm file was copied, so no per-grammar licence attribution applies. THIRD_PARTY_NOTICES lists aider@5dc9490 only.
- (b) personalised PageRank with repomap.py weights, seeds from mentioned files and idents -> TestRankPrefersReferenced, TestRankSeeds, TestRankSkipsChatFiles, TestIdentWeight, TestMentions -> done
- (c) output fits the token budget via binary search -> TestBudget, TestBudgetUsesInjectedMeter -> done. Deviation: aider may keep a tree up to 15% over budget; this port only keeps trees at or under it. internal/meter has no estimator, so `EstimateTokens` (4 bytes per token) is local and `Options.Tokens` is injectable.
- (d) mtime-keyed tag cache -> TestCacheKeyedByMtime, TestCacheSaveLoad -> done (key is path, mtime and size; saved to .factory/cache/repomap.json by the command)
- (e) parse runs in sandbox with size/time caps -> TestParseCaps, TestParseStopsMidFile -> partly done: 512 KiB size cap and 2 s per-file timeout. No OS sandbox: the parse is in-process pure Go with no exec or file writes, and I did not wire landlock.
- Bite-check: reverted each of these once and saw its test fail: mentioned-ident weight (TestRankSeeds, TestIdentWeight), PageRank personalization (TestRankSeeds), chat-file skip, budget search (TestBudget), cache mtime key, size cap, mid-parse cancel. Two mutants first survived (personalization, budget); I strengthened those tests and they now fail.
- Not done: the other tickets in the brief (#2 eval, #3 applier) belong to other sessions. The other copy-list rows were not touched.
## API change requests
- A shared token estimator in `internal/meter` (or `internal/api`) so `repomap.EstimateTokens` can be dropped.
## Files outside my area
- `cmd/factory/main.go`: one import and `repomap.NewCommand()` added to the root, so the package is reachable from cmd/factory.
- `docs/cli-reference.md`: regenerated with UPDATE_GOLDEN=1 because the new command changes it (TestCLIReferenceFresh).
- `THIRD_PARTY_NOTICES.md`: new `## Aider-AI/aider@5dc9490` section.
## Measures
- Non-test Go lines (`git ls-files ... | grep -v '^src/'`): before 20357, after 21063 for the same file set including untracked (+705, all in repomap). Nothing in my area was redundant to delete.
- Deadcode: 68 before, 68 after.
- `just` is not installed; I ran the justfile recipes by hand: gofmt -l, go vet, golangci-lint v2.13.2 under go1.26.7, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. The Symphony spec was fetched to /tmp/symphony-spec.md but this ticket has no scheduler behaviour, so no section is cited.
## Gate evidence
```
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.059s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.393s
GATE-OK
```
(GATE-OK is my echo after gofmt, vet, golangci-lint, race tests and the static build all exited 0.)
## Learnings
- `just` missing in the cloud image: bake it in, or add a `scripts/gate.sh` so the recipe is not retyped.
- The brief's CGO fallback needs deciding up front: say in the ticket that .scm files are skipped when CGO is off, so acceptance (a) is not written around them.
- The lint+race gate takes over 2 minutes and the default tool timeout is 120 s: run it in the background.
