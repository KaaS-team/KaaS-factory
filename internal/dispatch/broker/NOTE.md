# Broker versus passing the token in the environment

Today `internal/dispatch/local` copies the operator's environment into the session (minus provider
keys), so a GitHub token sits in the sandbox for the whole run. With the broker the session asks per
call; the long-lived secret stays in the broker process and the gate sees `repo.read`, `pr.create`
and so on before a credential exists.

Measured on a 4-core 2.1 GHz Xeon, Go 1.26, one GitHub adapter (`go test -bench . ./internal/dispatch/broker`):

| | environment token | broker |
|---|---|---|
| latency per call | 0 | 0.4 us in memory, 5.9 us with the file read per mint |
| heap per broker | 0 | under 1 KiB (`TestBrokerHeapStaysSmall` pins under 1 MiB) |
| extra process | none | none in this spike; the caller must reach the broker (not built) |
| secret in sandbox | whole run | until `ExpiresAt` |

Limits: the GitHub adapter returns the source token, so it shortens exposure but does not narrow scope.
Narrowing needs installation tokens with a permission set (`internal/githubauth` mints them). The
interface shapes follow kora `credentials/adapter.go` (Apache-2.0) but are written fresh, no file is
copied. Nothing calls the broker yet: wiring a transport and the CEL gate needs edits to `cmd/` and `internal/dispatch/local`.
