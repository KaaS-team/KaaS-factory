# f-audit-otel report

## Demo commands
```
$ FACTORY_AUDIT_DIR=/tmp/audit factory audit export --since 7d
{"Timestamp":"2026-11-19T19:50:28Z","SeverityText":"INFO","Body":"tracker.comment 12: ok","Attributes":{"action":"tracker.comment","actor":"factory","result":"ok","target":"12","ticket":"12"}}
$ factory audit export --since 12h --format csv
timestamp,severity,actor,action,target,result,ticket,body
2026-11-19T19:50:28Z,INFO,factory,tracker.comment,12,ok,12,tracker.comment 12: ok
```
Every factory command now records to `.factory/audit/YYYY-MM-DD.jsonl`. Set
`OTEL_EXPORTER_OTLP_ENDPOINT` to also send records to an OTLP/HTTP collector.

## Acceptance
- Structural test walks every tracker write method (github, jira, linear): done (`internal/audit/structural_test.go`). It also fails when a new `api.Tracker` or `api.Thread` method is not classified.
- httptest OTLP receiver gets the records when the env var is set: done (`TestOTLPReceiverGetsRecordsWhenEnvSet`).
- Each new test fails with the code reverted: done for the structural test (removed an audit line from jira SetPhase, test went red) and the github Comment test. The OTLP test needs `NewOTLPFromEnv`, so it fails without it.
- Gate: gofmt, vet, lint, race tests, build and ratchet all pass (run via gate.sh; `just` is not installed here).
- Secrets redacted before writing (existing `logs.Redact`): done, tested.
- `factory audit export --since 7d [--format jsonl|csv]`: done.

## Not covered
- PR merge: the factory merges through git (merge queue), not a GitHub merge call, so no merge record exists. The push that lands it is recorded (`git.push`).
- `PutSpendComment` on GitHub can write two records when it posts the first time (it calls `Comment`).
- Labels: recorded as one `tracker.set_phase` record, not one per label.

## Upstreams copied
None. Used go.opentelemetry.io/otel (log, sdk/log, otlploghttp), Apache-2.0, as a dependency only.

## Files outside my area
`.ratchet.json` (+369 lines, reason added), `cmd/factory/main.go` (registers `audit`, installs the sink), `internal/core/control.go`, `internal/gitx/gitx.go`, `internal/tracker/{github,jira,linear}` (one line each), `docs/cli-reference.md` (regenerated), `go.mod`, `go.sum`.

## Workflow changes needed
None.

## CI notes
The repo's `prcheck body` rejects a PR body that links a Claude session, so the PR body carries no session link or footer. A rerun of that check replays the old PR body, so only a new push picks up the edit.
