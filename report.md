TICKET: m2-k5b
NEXT: 71ae958f5410cbcfd1cb294a54a981c91dcbdee8
## Merged
- None with new content. All five were already on next, so each got a tree-neutral `-s ours` merge, which makes the branch an ancestor of next (merge commits d7aefe0, 446214d, d61291f, 6edb47f, 71ae958).
## Skipped
- none
## Already on next
- go/k5-packs-manifest -> next has squash-merge 55181e8; every file the branch changed under internal/packs is byte-identical on next.
- go/k5-repomap -> next has 11c8848; internal/packs/repomap/* byte-identical.
- go/k6-astgrep-pack -> next has 4eff92b; internal/packs/astgrep/* byte-identical.
- go/k6-checkmd -> next has 092a91a; internal/packs/checkmd/* byte-identical.
- go/k6-checkpoint -> next has 161d031; internal/gitx/checkpoint/* byte-identical.
- Shared files (THIRD_PARTY_NOTICES.md, docs/cli-reference.md, cmd/factory/main.go, go.mod, go.sum): every line each branch added is present on next.
- A plain merge of k5-packs-manifest conflicted in THIRD_PARTY_NOTICES.md and would have duplicated the goose and OpenHands sections; I discarded it and used `-s ours` instead.
## Bite checks
- none: no behaviour added or fixed, no code changed.
## Review notes
- k5-packs-manifest: `packs run <pack.yaml>` loads the manifest with an empty hash (LoadManifest(args[0], "")) and executes its `sh -c` retry checks without checking factory.lock. This is an explicit local CLI, not a bug, but a pack not verified against the lock can run shell. Worth a follow-up.
- k5-repomap, k6-astgrep-pack, k6-checkmd, k6-checkpoint: not re-reviewed in full; content is identical to what next already carries.
## Gate evidence
`just` is not installed here, so I did not run the full `just check`; the tree is identical to origin/next, so the gate result is unchanged. Not run: golangci-lint, full `go test -race ./...`, the `-tags ee` tests and the static build.
Run by hand with go1.26.0 (GOTOOLCHAIN=auto):
- `go test -race -count=3 ./internal/packs/... ./internal/gitx/checkpoint/...`: ok (packs, astgrep, checkmd, repomap, checkpoint)
- `go run ./tools/ratchet`: go_lines 27632 (baseline 27632), deadcode 189 (baseline 189). That run was on 41bb395 plus my merges, before the final rebase.
- gofmt -l and go vet on the touched packages: clean (first attempt only).
## Learnings
- Check whether a branch is already on next (squash merge) before a plain `git merge`; it conflicts on notices and would duplicate sections.
- `just` was not installed.
- next moves fast; the push loop's grep for success was wrong, so I verified by comparing HEAD with origin/next.
