BRANCH: go/k3f-goal-audit
HEAD: 1c4c2fe91f2a85476e8ef4b9fee2dca7e964f7c9 (report commit; no code branch pushed, audit read `origin/next` at 1b4ca338da9a2be877622e4e9f25255f59d709ec)
## Summary
The binary mounts 25 commands and the core loop, meter, merge queue, plan, eval, first-run and packs are reachable, but the workflow graph, chatops and trust, markers, spend ledger, serve, a2a, sandbox, tutor, browser check, self-update and GitHub App auth are not. Worse, the loop names every brief `<t>-a<n>.md` while all three dispatchers require `v9-<t>-a<n>.md`, so `factory run` and `factory dispatch` cannot start a session on any adapter (read from the code, not executed).
Measured on `next`: non-test non-TS Go is 20032 lines (18480 without `ee/` and `internal/api/porttest`) against the 8K budget. `deadcode` reports 231 unreachable functions (brief said 230); run with go1.26 (`GOTOOLCHAIN=go1.26.0`, binary from `go install ...deadcode@v0.39.0`). I did not edit files.

### 1. Plan features: reachable, unreachable, missing
Reachable from `factory --help` (cmd/factory/main.go:41-83, commands.go:19-30): version, status, run, queue, config get|explain, doctor, dispatch|steer|cancel|retry, board (tui), dashboard, first-run, upgrade, mcp, report, init, plan (+`--approve` filer, `--epic`), eval, add, packs list|verify, logs.
- Core loop: `core.Core.Run` (internal/core/core.go:133) calls `reconcile.Tick` (core.go:158), which uses `pick.Rank/Refill` (reconcile/decide.go:184), meter Record/Check with steer at 80% and stop at 100% (core.go:240-275), the fire budget on the board (core/control.go:46), the merge queue (core.go:299, mergeq/wire via cmd/factory/control.go:155), observer and shadow dispatcher.
- Trackers github, linear, jira (control.go:64-78) and dispatchers claude-cloud, fire, local (control.go:80-110).
- Local `--max-budget-usd` (dispatch/local/preset.go:177). `ANTHROPIC_*` doctor check (cmd/factory/doctor.go:88).

Exist but unreachable (deadcode, file:line is the first dead function):
- Workflow graph engine, 39 funcs, imported by no package: internal/graph/load.go:47, frontmatter.go:56, template.go:86. Per-node agent and tier and fresh-session verify exist only as data in graph.go:55.
- Chatops, trust, markers: tracker/github/chatops.go:66 (ParseChatOps), :114 (NewTrust), marker.go:36 (ParseData), :56 (EncodeData). The tracker works from labels and comments only.
- PR body: tracker/github/prbody.go:135 (RenderPRBody). Nothing builds the PR body from the plan and verdict.
- Spend ledger comment `<!-- factory:spend v1 -->`: meter/ledger.go:54 (EncodeSpend), :81 (DecodeSpend). Cloud usage: meter/cloud.go:24 (NewCloudUsage). The ledger is never written to the issue.
- reconcile.Run (reconcile/run.go:39) and reconcile.Backoff (decide.go:46).
- pick.LocalOnly and pick.RefillRouted (pick/route.go:52,66): the #635 local path for `.github/workflows`.
- serve: cmd/factory/serve.go:17 `newServe` is never added to root; internal/serve (198 lines) has 9 dead funcs.
- a2a (internal/a2a/command.go:26), sandbox (pkg/sandbox/sandbox.go:67, :89), browsercheck (browsercheck/run.go:54), tutor (tutor/tutor.go:41), selfupdate (selfupdate.go:51,100), githubauth (githubauth.go:121 App.Token), conformance (checklist.go:33,143), smoke (smoke/run.go:163), provenance.Check (provenance.go:29, test only), docgen (docgen.go:14, test only), packs.FromUpstreams (packs/upstreams.go:22), gitx.LeaseRef (gitx.go:147), config.Describe and Keys (describe.go:33, keys.go:123), logs.Local.Poll and StoreLookup (logs/local.go:29, lookup.go:14), logs for local sessions, shadow.Summary (shadow/file.go:59), eval WithRunner/WithNow, report WithNow.
- internal/api/porttest has 34 dead funcs because only tests use it: expected, not a defect.

Missing (no code anywhere):
- `factory plan` for goal to spec to tickets with `Files:` overlap check: `plan/intent` exists (118 lines) and `plan/dag.go` carries Files, but no `merge-tree` pre-check is called before dispatch.
- Stall detector second stage (steer, then retry with backoff, then needs-human with session URL): only the retry exists in Decide; I found no steer-at-stall path.
- `factory packs upgrade` is `factory upgrade`: command name differs from the plan. `factory add` writes the lock, and no nightly routine exists for upgrade.
- The first-hour wow, steps 4 and 5 (one real PR, scorecard with estimate vs actual): internal/firstrun (335 lines) ends at the report.
- Symphony §18 conformance in nightly: the checklist tests exist, no workflow calls them (I found no `.github/workflows` file that references them; not checked in depth).
- Hidden-test fixtures for `eval` against real agents: the matrix runs with a runner function and has no agent-matrix path.
- No-API-key test on dispatch env: doctor has it; I found no test asserting the dispatch env of the three dispatchers.

### 2. Code not in the plan (scope creep), non-test lines
Not in the plan's design list but named in this wave's kept list: a2a 306, pkg/sandbox 405, tutor 92, browsercheck 235, selfupdate 289, githubauth 167, serve 198. Total 1692, all unreachable.
Not in the plan or the kept list: internal/smoke 471 (a live-repo harness, unreachable), internal/conformance 166 (test support, unreachable), internal/docgen 67 (unreachable), pkg/agentrun 93 (public alias layer, unreachable by design, one test), internal/tracker/vendorkit 242 (shared by linear and jira, reachable).
ee/ is 1209 lines (scim 685, sso 358, policy 166): the plan keeps it behind `//go:build ee`, but nothing in cmd/ mounts it.
Over-size in kept packages (plan layout has no budget per package): graph 1186 for an engine nothing calls.

### 3. Two implementations of one concept
- Loop: `reconcile.Run` (reconcile/run.go:39, dead) vs `core.Core.Run` (core/core.go:133, live). Both drain events and call Tick. Keep core.Run, delete reconcile.Run and drain.
- Backoff: `reconcile.Backoff` (decide.go:46, dead) vs `Config.backoff` (decide.go:220, live), both over backoffCap.
- JS-style JSON string encoder: meter/ledger.go:132 and tracker/github/marker.go:75, identical body.
- Marker regex and codec: tracker/github/marker.go:30, meter/ledger.go:17, mergeq/corequeue.go:60 each parse `<!-- factory:x {...} -->` by hand.
- Brief file name: built in core/control.go:60 and reconcile/run.go:298 as `<t>-a<n>.md`, and in dispatch/brief/brief.go:28 as `v9-<t>-a<n>.md`. The dispatchers compare (local.go:160, routines.go:130, fire.go:169) and refuse the loop's name. This is the defect from the summary. smoke/run.go:123 `nameFixer` works around it for the smoke harness only.
- Dispatch surface: pkg/agentrun re-exports `local`, `routines` and `meter` constructors, a third way in beside cmd/factory/control.go.
- Workflow reading: graph (dead) vs the `Workflow string` on Brief and Ticket that the live loop passes through unread.

### 4. Five changes, fewest lines, ranked
1. Make the brief name come from `brief.Name` in core/control.go:60 and reconcile/run.go:298 (about 6 lines, plus one test that runs a real `local` dispatcher through `Core.Dispatch`). It unblocks everything the binary exists to do. Then delete `nameFixer`.
2. Add `root.AddCommand(newServe())` in cmd/factory/main.go and mount `a2a.NewCommand` (2 lines). It makes 198 and 306 lines reachable; both already have tests of the handlers.
3. Write the ledger: in `Core.meterPass` (core.go:240) after `Record`, call `meter.EncodeSpend` and `Tracker.Comment` (about 15 lines). It closes the tokenomics claim (#125) and gives `factory report` real input.
4. Wire markers, chatops and trust into the github tracker's `Comments` and `markerTrusted` (queue.go:40,62), using `ParseChatOps` and `Trust` (about 40 lines). It makes `/factory approve|revise|retry|cancel` real.
5. Load `.factory/workflows` through `graph.LoadDir` in `buildDeps` and pass node agent, tier and budget into the Brief (about 60 lines), or delete 1186 lines. Recommend wire: it is the plan's per-node agent and tier. If not done this wave, delete it: dead code that tests green is the worst case.
Cut candidates if lines matter more than features: smoke 471, docgen 67, the `conformance` package after its tests move under reconcile.

### 5. Quality since `ts-final` (179 commits), worst first
1. internal/dispatch/brief, core/control.go:60 and reconcile/run.go:298: tests for core and for each dispatcher pass because each uses its own name; none runs the two together. The loop cannot dispatch on any adapter. No test would fail.
2. cmd/factory/serve_test.go:6 `TestServe_Flags` asserts two flag defaults of a command that is not mounted (main.go:60-83). It would pass with the command deleted from the binary.
3. internal/a2a/command.go:24 comment says "returns `factory a2a --addr`"; no such command exists. `TestCommandRefusesEmptyToken` (a2a_test.go:228) tests it.
4. internal/smoke/smoke_test.go:157 `TestShadowQueueNeverRuns` tests `shadowQueue{}` (smoke/run.go:138), a test-only wrapper that returns an error by construction. The code under test is the mock.
5. internal/smoke/smoke_test.go:68 `TestRunMergesTheTicket` runs `Run` with `nameFixer` (run.go:123), which rewrites the one field the live loop gets wrong, so the real defect is hidden by the test double.
6. internal/conformance/checklist_test.go:34,53,69: the "every item has a test" tests parse the test files with `go/parser` and compare names with a hand-written table (Rows17, dead). They check that names exist, not that the behaviour holds.
7. pkg/agentrun/agentrun_test.go:36-60: polls a script for up to 10 s with sleeps and tests alias forwarding. Only the behaviour of local/meter is checked, and those packages have their own tests.
8. tracker/github/chatops.go and marker.go have unit tests with goldens (marker_test, chatops_test), but nothing reaches them from `Tracker`, so a trust bug in comments would not fail any test. Same for prbody.go and meter/ledger.go.
9. internal/docgen tests (docgen_test.go:26,49) compare generated docs to goldens through functions no command calls; the config docs can drift from `config.Keys` only if someone runs docgen by hand.
10. internal/provenance/provenance.go:29 `Check` is called only from its own test; Rule 0 asks for a wired check, and `just check` runs the test, not a CLI.
No test without any assertion was found by an AST scan of every `_test.go` outside `src/` (only `TestMain` in pkg/sandbox).

## Acceptance
- 1. Plan features reachable, unreachable, missing, with file:line -> section 1 above -> done
- 2. Code not in the plan, with size in lines -> section 2 -> done
- 3. Two implementations of one concept -> section 3 -> done
- 4. Five ranked changes for fewest lines -> section 4 -> done
- 5. PR and commit quality since ts-final, at most ten, worst first -> section 5 -> done

## API change requests
none

## Files outside my area
none (no file edited; local branch `go/k3f-goal-audit` was created from `origin/next` and not pushed)

## Gate evidence
Not run: the brief says no code, and `just` is not installed. Measured instead:
- `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l` -> 20032
- `deadcode ./...` (v0.39.0, go1.26.0) -> 231 lines, by package: graph 39, porttest 34, tracker/github 25, a2a 20, smoke 19, pkg/sandbox 13, meter 12, selfupdate 11, serve 9, githubauth 6, browsercheck 6, conformance 5, logs 4, tutor 3, reconcile 3, docgen 3, others 1 to 2 each
- `CGO_ENABLED=0 go build ./cmd/factory` -> ok

## Learnings
- `go run golang.org/x/tools/cmd/deadcode@v0.39.0` under go1.24 fails with "requires newer Go version go1.26"; use `GOTOOLCHAIN=go1.26.0 GOBIN=/tmp/bin go install` then run the binary.
- Each slice was tested against its own fakes; no test ran the loop with a real dispatcher, so a name mismatch in the central path survived 179 commits. The factory's default should be one test per wave that drives `factory run` against a real adapter and a local git remote.
- A package with tests and no importer looks finished; the gate should fail when a non-test package under internal/ has no importer (Rule 0 applied to packages).
