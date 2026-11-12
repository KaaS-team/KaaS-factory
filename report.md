TICKET: m3-wire-c
NEXT: 5ed582659d5581cea82e1f3ba254913036c1256f
## Wired
- internal/review (+ checkmd.Parse/Select as its Source) -> new `factory review` (cmd/factory/review.go): runs `.factory/checks/*.md` packs that cover the uncommitted changes, one worktree each, exits non-zero on a patch or error. Tests: TestReviewCommandRunsSelectedPacks, TestReviewCommandFailsOnPatch. Matches the existing `run: factory review` in internal/review/review-only.yml. Added `local.ChildEnv` (exported wrapper) so the agent gets the provider-key-free env.
- internal/reconcile/eventlog.Open -> `buildDeps` in cmd/factory/control.go sets `core.Deps.Log` (.factory/cache/steps), so `factory run` / serve replay the step log on restart. Test: TestGitHubDepsAreReal.
## Deleted
- checkmd.Runner, checkmd.Prompt and their helpers (and run_test.go) -> a second copy of review.Runner, ported from the same file; nothing selects it. Its THIRD_PARTY_NOTICES line went with it.
## Left unwired
- internal/smoke -> opt-in live test driver (`go test -run Live`, docs/smoke.md); a `factory smoke` command needs API/remote flags and a real sandbox repo, not done.
- internal/packs/astgrep, internal/packs/depup, internal/packs/signed.go, internal/packs/category.go -> need a design call (depup: where updates come from; astgrep: jail/binary pin in a check workflow).
- internal/pick (DLQ, errclass, Fair), internal/plan FilterUses/UsesMetric, tracker/github PlanApproval -> core/reconcile loop changes, beyond a cmd-level wiring.
- internal/tracker/safeout -> apply stage needs a write-credential split in serve; not started.
- internal/store/crypt, store/conformance -> no consumer yet (conformance is test-only by design).
- pkg/sandbox, cachevol, egress -> sandbox lifecycle/proxy not selected by any dispatcher yet; other sessions touch it.
- pkg/agentrun (public re-export, by design), internal/provenance (test helpers), internal/report.WithNow (test clock seam; left rather than touch its tests).
## Bite checks
- TestReviewCommandRunsSelectedPacks / TestReviewCommandFailsOnPatch -> with `reviewCmd()` removed from commands.go: `review_test.go:69: unknown command "review" for "factory"`
- TestGitHubDepsAreReal -> with `Log: nil`: `assemble_test.go:224: deps carry no step log`
## Ratchet
deadcode 404 -> 381 on my base (385 after rebasing onto others' merges, baseline 385); go_lines 40997 -> 40942 on my base (41670 after rebase). .ratchet.json conflicts resolved by taking next's and re-running --update.
## Gate evidence
(no `just`; ran ./gate.sh, the same steps)
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 41670 (baseline 41670), deadcode 385 (baseline 385)
## Learnings
- `go run deadcode@v0.39.0` needs GOTOOLCHAIN=go1.26.0 set explicitly, or it reports "requires newer Go".
- `./gate.sh` takes one step list in $1 only; multiple args run just the first.
- Deleting a ported file also needs its THIRD_PARTY_NOTICES line removed (provenance test).
- Most of my share is big design work (sandbox, safeout, depup); only a small part was a clean wiring.
