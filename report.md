TICKET: m3-fixes-j2
NEXT: 48ff51d53f4a3096f5bdcd6d563899dfe3423fb8
## Fixed
- 1 resume with no stored interrupt -> 52009c5, core TestAnswerWithNoPendingInterruptIsRefused. Also updated TestRestartResumesAtTheNodeReached: its restarted Core has a fresh store, so it now re-raises the interrupt a persistent store would still hold.
- 2 encrypted store accepts plaintext -> 43adf05, crypt TestKeyedStoreRefusesUntaggedRows (replaces TestPlainAndEncryptedRowsBothLoad, which asserted the old behaviour). Error holds thread and id only, no data. Keyless reads of untagged rows unchanged (the raw store).
- 3 trajectory name collision -> 81302d3, trajectory TestFileNameIsInjective. Each byte outside A-Za-z0-9._- becomes %XX (so `a/b` -> `a%2Fb.json`); the existing file-name assertion was updated.
- 4 submission not verified -> 095c2d3, TestReplayRejectsBrokenFiles (new cases "cut", "submission edited") and TestSubmissionOnlyFileLoads. The old "cut" case (last step diff removed, submission intact) now loads by design; it now removes the submission instead.
- 5 eval.Replay nil Triggered -> 57ff24d, eval TestReplayRejectsGateSpanWithoutTriggered (also guards a nil span).
- 6 trace files world-readable -> 1351976, trace TestFileSinkCreatesPrivateFile (0600 via OpenFile).
- 7 restart order -> f0f7ba3, core TestRestartPrefersThreadPositionOverCheckpoint. The order WAS wrong: stageOf took the checkpoint before the thread position. The thread position is held by GitHub and survives a lost or restored local checkpoint store; the checkpoint is local. stageOf now takes the thread position when the two name different nodes; when they agree the checkpoint is used (it carries tier, history, saved result). A thread position naming an unknown node falls back to the checkpoint. Tradeoff: if a GitHub position write failed after a checkpoint write, the restart is one node behind and re-runs it.
- Ratchet: 48ff51d raised go_lines 39077 -> 39103 (+26) with the reason updated.
## Bite checks
- TestAnswerWithNoPendingInterruptIsRefused -> `interrupt_test.go:78: resume error = <nil>, want ErrNothingPending`
- TestKeyedStoreRefusesUntaggedRows -> `crypt_test.go:71: planted untagged row: ok=true err=<nil>, want an error`
- TestFileNameIsInjective -> `trajectory_test.go:167: collision: a-b.json a-b.json a-2Fb.json`
- TestReplayRejectsBrokenFiles / TestSubmissionOnlyFileLoads (old Replay) -> `trajectory_test.go:55: submission edited: replay succeeded`; `trajectory_test.go:186: load = [], ...s.json: trajectory s: last step diff does not match the recorded checksum`
- TestReplayRejectsGateSpanWithoutTriggered -> `panic: runtime error: invalid memory address or nil pointer dereference`
- TestFileSinkCreatesPrivateFile -> `trace_test.go:104: trace file mode = 644, want 600`
- TestRestartPrefersThreadPositionOverCheckpoint -> `stage_checkpoint_test.go:148: stage at plan base 0, want the thread position (ship, 2) over the checkpoint (plan)`
`go test -race -count=3` passed on internal/core, internal/store/..., internal/eval/..., internal/trace.
## Not fixed
- Nothing skipped. Left out on purpose: `resume()` still calls `restore` (memory, then checkpoint) directly without the position comparison; it only runs after stageOf has populated memory. No docs rewritten.
## Dependency check
- elimity-com/scim: pinned v0.0.0-20261112130359-73634688791c, commit 73634688791c, published to proxy.golang.org 2026-11-12T13:03:59Z (the day of this run). The proxy lists no tagged versions. Copyright 2019 Elimity NV, so the project is about 7 years old, but this exact commit is hours old. Licence: MIT (LICENSE.md). Maintainer: Elimity NV (org elimity-com), from the licence header; GitHub API access was denied in this session, so stars, archive status and commit history are unchecked. Not in THIRD_PARTY_NOTICES.md or NOTICE (grep found nothing). Verdict: licence fine; do not rely on a same-day, untagged commit without review. Prefer a tagged release or a pin to an older reviewed commit, and add a notices entry. Left unchanged as instructed.
## Gate evidence
./gate.sh run once on the final tree before the push (the push was a fast-forward, origin/next was d25139f, so no merge and no tree change after it; I did not run it a second time):
ok  	github.com/KaaS-team/factory/tools/gate	1.040s
ok  	github.com/KaaS-team/factory/tools/ratchet	1.020s
go_lines 39103 (baseline 39103), deadcode 380 (baseline 380)
EXIT 0
## Learnings
- Go 1.24 on the host needed GOTOOLCHAIN=auto to fetch 1.26.
- A first gate started mid-edit was wasted; start it after the last commit.
- Tests that restart a Core with a fresh store hid defect 1; the fix needed one of them updated.
- Stash-the-fix bite checks are quick: `git stash -- <file>`, run test, `git stash pop`.
