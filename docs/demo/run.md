# Demo: one ticket to one pull request

`factory run --headless` prints one JSON event per line. This page shows what that stream looks like
when tickets run on the `local` dispatcher. The agent here is a fake `claude`: a shell script that
edits a file, commits and pushes. The harness reads the push and opens the pull request. The agent
never writes to GitHub.

The e2e test `internal/reconcile/run_e2e_test.go` runs this loop with no network. Run it:

    go test ./internal/reconcile -run 'TestRunTwo|TestStalled' -v

## Two tickets, two pull requests

Two slots. Each ticket is dispatched, pushes a branch with a report, gets a PR, is queued and
lands. Its lease ref is released at the end. Time is removed so the stream is stable.

```json
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"dispatched","ticket":"t1","data":{"attempt":1,"session":"factory-t1-a1"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"pushed","ticket":"t1","data":{"attempt":1,"branch":"factory/t1-a1"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"queued","ticket":"t1","data":{"pr":101}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"merged","ticket":"t1","data":{"pr":101}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"dispatched","ticket":"t2","data":{"attempt":1,"session":"factory-t2-a1"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"pushed","ticket":"t2","data":{"attempt":1,"branch":"factory/t2-a1"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"queued","ticket":"t2","data":{"pr":102}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"merged","ticket":"t2","data":{"pr":102}}
```

## A stalled session

The session for ticket `slow` never pushes. After `stall_after` the loop sends one steer (the
`stalled` event). Still no push, so it cancels the session and queues a retry after the Symphony 8.4
backoff (the `retried` event). Attempt 2 pushes and gets its PR.

```json
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"dispatched","ticket":"slow","data":{"attempt":1,"session":"factory-slow-a1"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"stalled","ticket":"slow","data":{"message":"No push seen for a while. Commit and push what you have, then continue, or say what blocks you."}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"retried","ticket":"slow","data":{"attempt":2}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"dispatched","ticket":"slow","data":{"attempt":2,"session":"factory-slow-a2"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"pushed","ticket":"slow","data":{"attempt":2,"branch":"factory/slow-a2"}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"queued","ticket":"slow","data":{"pr":101}}
{"v":1,"time":"0001-01-01T00:00:00Z","kind":"merged","ticket":"slow","data":{"pr":101}}
```

## Notes

- The lease refs (`refs/factory/lease/<ticket>`) are taken and released by the test's tracker. The
  Go tree has no lease code yet, so this checks the shape, not a shipped feature.
- The test puts the fake `claude` first on `PATH`. The dispatcher resolves the name `claude` against
  that, so a real `claude` on the machine would otherwise run.
