# f-dead-jobs

Deleted the unreachable jobs server from `internal/serve`.

## 1. Demo commands

```
$ git diff --stat origin/next -- internal cmd
 internal/serve/jobs.go        | 568 deletions
 internal/serve/jobs_test.go   | 534 deletions
 (jitter.go, jitter_test.go, serve.go, serve_test.go trimmed)
$ go list ./... | grep -c jobs
0
$ go test -race ./internal/serve/...
ok  github.com/KaaS-team/factory/internal/serve
$ go run ./tools/ratchet
go_lines 42261 (baseline 42261), deadcode 309 (baseline 309)
```

## 2. Acceptance

- [x] No /jobs route: `TestHandlerRoutes` walks the route table. It asserts `/healthz`, `/readyz` and `/events`
  exist and the four `/jobs/*` routes do not. With the change reverted it fails:
  `serve_test.go:288: PUT /jobs/a: registered=true, want false`.
- [x] `.ratchet.json` go_lines 42880 to 42261 (-619). deadcode stays 309.
- [x] `Serve` has one stop path: the loop ending, the HTTP server failing and ctx ending go through one
  `select`, then one `stopHTTP`. The existing drain and stop tests cover it and still pass.
  Dropped `Options.Jobs`, `JobsPath`, `Exec`; nothing outside `internal/serve` used them.

`jitter.go` stays, trimmed to `JitterOffset` and `DefaultJitterWindow`, because the cron scheduler
(`schedule.go`) uses them. Only the `Jobs` methods were removed. `go mod tidy` made no change.

## 3. Upstreams copied

None. Nothing new copied. The existing trigger.dev header on `jitter.go` stays.

## 4. Files outside my area

None. Workflow changes needed: none.

## Notes for the next session

`tools/prcheck` body check rejects any PR body containing `claude.ai/code` or `Claude-Session:`. A session
footer on the PR body fails CI, and a re-run replays the old body, so only a new push picks up an edit.
A Claude session link must not go in the body.
