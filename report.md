BRANCH: go/k9-a2a-v1
HEAD: 3b5a2bc3e2fb2f084653b34325e209ecb6f2e6d9
## Summary
`internal/a2a` now serves A2A v1 JSON-RPC (with streaming) through a2a-go's `a2asrv` behind an `AgentExecutor` over the tracker. The agent card is signed with a2acrypto and its JWKS is served. An interceptor writes one audit row per call. The hand-written `RequestHandler` is deleted. v0.3 stays available through the SDK compat handler.

## Already on the base branch
- a2a-go v2 was already a dependency, and `internal/a2a` already served v0.3 over a hand-written `RequestHandler` (SendMessage, GetTask, bearer auth, phase-to-state table, agent card golden, `factory a2a` command). I kept the phase table, bearer auth, ticket filing and PR artifact logic.
- Nothing for signing, streaming or audit existed.

## Acceptance
- Agent card served and signed with a2acrypto -> TestAgentCardSignedAndVerifies (verifies against the served JWKS, a tampered card fails), TestLoadKey, TestLoadKeyAccepted -> done
- message/send works over v1 -> TestV1SendAndGet, TestV1RefusalsFileNothing, TestV1RejectsMissingToken -> done
- Streaming works -> TestV1Streaming -> done
- "Against a2a-go's itk conformance suite" -> blocked: the suite (e2e/tck, Python) needs network and an external runner. I used the SDK's own a2aclient against an httptest server instead. Not the same suite.
- Old hand-written handler deleted -> `server` type and its methods removed from a2a.go -> done
- Interceptor writes an audit row per call -> TestAuditRowPerCall, TestAuditFailureRefusesCall, TestJSONLAuditor -> done. A streaming call's row is written at its first response.

Bite-checks (each fix reverted once, its test went red): unsigned card -> TestAgentCardSignedAndVerifies; no status events -> TestV1Streaming; no interceptor -> TestAuditRowPerCall and TestAuditFailureRefusesCall; always v0.3 -> four V1 tests; typed-nil guard in audit -> TestAuditRowPerCall and TestAuditFailureRefusesCall; no live phase overlay -> TestSendThenGetRoundTrip, TestUnmappedPhase..., TestV1SendAndGet; swallowed sink error -> TestAuditFailureRefusesCall. I wrote most tests alongside the code, not strictly before it; the bite-checks stand in for the red step.

Behaviour changes to know about:
- The task id is no longer the ticket id. a2asrv assigns it; the ticket id is in task metadata (`ticket`). Tasks live in the SDK memory store, so they are lost on restart (state is still read live from the phase).
- A send without returnImmediately (v1) or blocking:false (v0.3) now waits until the task completes or needs input, because the SDK keeps an execution open until then. The old server returned at once.
- Each open task polls the store every 5 seconds (not the tracker). The execution context comes from the SDK, so shutdown relies on it.
- The card is v1 only, so a v0.3-only client cannot parse it. Requests without an `A2A-Version: 1.x` header still get v0.3.
- Cancel and follow-up messages to an existing task are refused.
- Without `--signing-key` (ECDSA P-256 PEM) a new key is made at each start. The ee SSO key wiring was not done.

Left out: the other copy-list rows (push sender, workqueue, limiter, ACP, A2UI, ag-ui) belong to other tickets. No file was ported, so THIRD_PARTY_NOTICES.md is unchanged.

Measures:
- Non-test Go lines (brief's command, computed from origin/next for "before"): 21276 -> 21562 (+286). Not the 20357 the brief quotes; I did not find why.
- Deadcode: 70 -> 70, same lines.

## API change requests
- An audit port in `internal/api` and a store-backed sink. `Auditor` is defined in `internal/a2a`, and the only sink wired is a JSONL file (`--audit-log`, default `a2a-audit.jsonl` in the working directory).
- A durable task store, so tasks survive a restart.

## Files outside my area
- `docs/cli-reference.md`: regenerated with `UPDATE_GOLDEN=1 go test ./cmd/factory` because I added the `--signing-key` and `--audit-log` flags (`TestCLIReferenceFresh` fails otherwise). Two lines.

## Gate evidence
`just` is not installed, so I ran its recipes by hand: gofmt, `go vet ./...`, golangci-lint v2.13.2 under go1.26.7, `go test -race ./...`, the same with `-tags ee`, and `CGO_ENABLED=0 go build ./cmd/factory`.
```
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.018s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.261s
GATE-OK
```

## Learnings
- `just` and a Go 1.26 toolchain are missing here, so the gate takes about 10 minutes by hand; bake them into the image.
- A generated doc (`docs/cli-reference.md`) fails the gate when a flag is added; the brief should list it as an expected touch outside the area.
- The a2a-go executor model keeps an execution open until a terminal or input-required state, so a "file and return" adapter hangs; the brief should say so.
- Early monitor patterns matched "error" inside module names in `go: downloading` lines; filter those out.
