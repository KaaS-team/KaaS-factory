# f-run report

Branch `demo/f-run`.

## Demo commands
    go test ./internal/reconcile -run 'TestRunTwo|TestStalled' -v
    --- PASS: TestRunTwoTicketsToPullRequests (0.26s)
    --- PASS: TestStalledSessionGetsOneSteerThenRetry (2.62s)
The recorded streams are in `docs/demo/run.md`. The CLI form is `factory run --headless --slots 2`
with a fake `claude` first on PATH; the test drives core.Core directly, which prints the same events.

## Acceptance
- e2e: two PRs on the fake tracker, both lease refs released, stream equals golden: done
  (`internal/reconcile/run_e2e_test.go`, `testdata/run_stream.golden`). The lease refs are made by
  the test tracker; the Go tree has no lease code.
- Stalled session, one steer then retry, shown in stream: done (`run_stall_stream.golden`).
- `docs/demo/run.md` with the recorded stream: done.
- Not done: the test goes through core.Core, not the `cmd/factory` binary (outside my area).

## Finding
The dispatcher resolves `claude` against the parent PATH, not the child env. The test sets PATH
with `t.Setenv`. Without it a real `claude` on the machine would run.

## Upstreams copied
None. machinist and gh-aw were not cloned (no network time); nothing copied.

## Files outside my area / workflow changes
None. The brief's `.factory/reports/` path is used; AGENTS.md says a hook may refuse it, so the same
text may need to go on `report/f-run` as `report.md`.
