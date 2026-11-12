BRANCH: go/k2f-serve
HEAD: 8f30a08a4eed8c3f1caa44329be1b4f3e051a518
## Summary
`factory serve` runs the core's Run loop plus an HTTP server (`/healthz`, `/readyz`, `/events` as SSE) in `internal/serve`, with SIGTERM drain, a systemd unit and a distroless Dockerfile. Supervisor line for `addCommands`: `root.AddCommand(newServe())`.
## Acceptance
- /healthz table (fresh 200, stale 503, never 503, fake clock) -> TestHealthz_Symphony8_1 -> done
- SIGTERM drain (exit 0 after release, non-zero with message past drain) -> TestServe_DrainExitsZeroAfterRelease, TestServe_DrainTimeoutIsAnError (plus TestServe_OpenEventStreamDoesNotBlockDrain, seen red without BaseContext) -> done
- /events streams first event (httptest, porttest fake) -> TestEvents_StreamsFirstEvent -> done
- Docker build evidence -> blocked: docker CLI exists but no daemon. Run: `docker build -f contrib/docker/Dockerfile -t factory .`
## API change requests
none. Serve takes a local `Core` interface (api.Control plus `Run(ctx)`), which core.Core satisfies; health is derived from the core's "tick" events.
## Files outside my area
none
## Gate evidence
`just` is missing; ran the recipe bodies by hand: gofmt -l . (empty), go vet ./... (clean), golangci-lint v2.13.2 (0 issues), go test -race ./... (all ok), CGO_ENABLED=0 go build ./cmd/factory (ok). Docker image not built (no daemon).
## Learnings
- `just` and a docker daemon are absent in cloud sessions; the brief should say so up front.
- /healthz is tick-event based, so a fake Core must emit "tick" events for health tests of the cmd layer.
- The cobra command test only checks flag defaults; no end-to-end serve test through newControl.
