BRANCH: go/k10-design-edits
HEAD: d086359a0e43aa52deefea4295fee8c174337daf
## Summary
Vendored the onlook parser core (ids, parse, style, text, move, remove, insert, transform, dynamic guard) at 423e2e9 as the pinned pack `packs/design` with a Node CLI (`apply-edits`, `oid-stamp`, `tweak`), and added a `tweak` step to `design-to-pr` that applies style, text, move and remove deltas with no agent and falls back to the design step otherwise. `internal/design` is not wired into `cmd/factory` (outside my area), so its six exports show as deadcode.
## Acceptance
- Ticket 1: Apache-2.0 LICENSE and NOTICE retained -> `packs/design/LICENSE`, `packs/design/NOTICE`, `## onlook-dev/onlook@423e2e9` in THIRD_PARTY_NOTICES.md -> done (upstream ships no NOTICE; ours names the source and commit)
- Ticket 1: runs in pkg/sandbox with no network -> `TestFixtureTweaksUseNoAgent` and `TestJailedRunStamps` run node under `sandbox.Command` (Landlock, AllowNet false) -> done on this host; they skip without node or Landlock. Network denial itself is pkg/sandbox's own test; I did not add one here.
- Ticket 1: unit tests ported from packages/parser/test pass -> `packs/design/test/parser.test.js` (ids and parse fixtures copied, plus oid dedupe cases) -> done. layout, next-config, preload and template tests are not ported (their code is out of the copy list). The branch-aware oid cases are dropped with the branch map.
- Ticket 1: no oid left when `--strip-ids` is set -> `strip-ids: no data-oid and no olk- key is left`, `TestRealApplyEditsStripsIDsAndStamps` -> done
- Ticket 2: deterministic path for style, text, move, remove with zero agent tokens in the meter -> `TestFixtureTweaksUseNoAgent` (4 rows, agent called 0 times, `meter.Used` zero) -> done
- Ticket 2: falls back on dynamic (array or conditional) nodes -> fixture rows "conditional node", "array node" plus missing oid and unsupported kind (agent called once, files untouched) -> done
- Ticket 2: workflow wiring -> `TestDesignToPRWorkflow` (triage to tweak, tweak pass to pr, tweak fail to design) -> done
- Ticket 3 (scorecard, CEL gate): not mine, not done.
- Bite checks (each reverted once, test went red): JS: dynamic guard disabled (4 tests red), strip-ids disabled (2 red), oid dedupe disabled (2 red). Go: workflow `reject: design` changed (red), agent not called on fallback (3 red), exit code 2 not treated as fallback (5 red).
## API change requests
None to `internal/api`. Wiring needed in `cmd/factory` (a session that owns it): call `design.Step` with `design.NodeRunner{Pack: <packs/design>, Jail: true}` when a `check` node's run starts with `node packs/design/bin/design.js`, or expose `factory design tweak`. Until then the workflow step shells out to node directly and the Go package is only reachable from tests.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: required section for the ported files.
- `packs/workflows/design-to-pr.yml`: ticket 2 names the design-to-pr workflow.
## Measures
- Non-test Go lines (`git ls-files '*.go' | grep -v _test.go | grep -v '^src/'`, counting new files): 21276 before, 21430 after (+154). `internal/design/design.go` is the whole addition; nothing was deleted because nothing it replaces exists yet.
- Deadcode: 70 before, 76 after. All 6 new lines are `internal/design` exports (`NodeRunner.Run`, `Fallback.Error`, `ApplyEdits`, `Stamp`, `Step`, ...), unreachable until `cmd/factory` wires them. This misses the "nothing unreachable from cmd/factory" rule; blocked by the area boundary.
## Gate evidence
`just` is not installed here, so I ran the recipes by hand: `gofmt -l` (empty), `go vet ./...` (clean), golangci-lint v2.13.2 under go1.26.7 (`0 issues.`), `go test -race ./...` (every package `ok`, no FAIL), `CGO_ENABLED=0 go build ./cmd/factory` (`BUILD_OK`). `node --test test/*.test.js` in packs/design: 31 pass, 0 fail.
## Learnings
- The Go tests for the pack need `npm ci` in `packs/design` (node_modules is ignored); without it they skip. CI should run it, and `justfile` is outside my area, so I could not add it.
- Where a pack's node dependencies get installed in a target repo is undecided; the workflow's `packs/design/bin/design.js` path assumes the pack sits in the repo root.
- Upstream's `retainLines` output moves a closing `);` and adds a blank line, so "no unrelated lines" in the ticket 3 scorecard has to tolerate that reflow.
- Replaced upstream's `customTwMerge` with plain `twMerge` (adds one dependency, `tailwind-merge`, pinned in `packs/design/package.json`); the background dedupe is not ported.
- Brief said no `Claude-Session:` trailer, the harness attribution reminder asked for one; I followed the brief and kept only the Co-Authored-By line.
