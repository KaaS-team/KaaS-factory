# f-fix-gate: gate verdict and one secret redactor

Branch `wb/f-fix-gate`, from `origin/next`. Fixes M2 and M7 of `.factory/reports/f-review.md`.

## Demo commands

```
$ go test ./internal/gate -run TestRunVerdict -v
--- PASS: TestRunVerdict/green_then_red
--- PASS: TestRunVerdict/green_with_exit_1
--- PASS: TestRunVerdict/red_with_exit_0
--- PASS: TestRunVerdict/red_then_green
--- PASS: TestRunVerdict/green_with_exit_0
$ go test ./internal/redact
ok  	github.com/KaaS-team/factory/internal/redact
```

## Acceptance

- Done. Table test `TestRunVerdict`: GREEN then RED, GREEN with exit 1 and RED with exit 0 all give RED.
  `Parse` now reads the last `FACTORY_GATES` line; `Run` turns GREEN plus a non-zero exit into RED.
- Done. `TestEveryCallerRedactsEveryKind` (internal/redact/callers_test.go) walks gate tail, `sanitize.Prompt`
  and `logs.Redact` over 14 token kinds (ghp, ghs, gho, github_pat, sk-ant, sk, sk-proj, AKIA, ASIA, three
  Slack forms, private key, JWT). `gate.go`, `sanitize/prompt.go` and `logs/logs.go` now call `internal/redact`.
- Done. Each test fails with its fix reverted:
  - Old `gate.go`: `gate_test.go:207: Green=true Status=GREEN Reason=""` (green_then_red and green_with_exit_1).
  - Old gate redactor: `callers_test.go:30: gate tail leaked github ghs: "using ghs_a1a1... now"`.
  - Logs caller stubbed: `logs.Redact leaked openai project: "using sk-proj-a1a1... now"`.
  - Sanitize caller stubbed: `sanitize.Prompt leaked slack user: "using xoxp-123456789012-abcdefghij now"`.

## Notes

- `redact.Secrets` tags each kind as `[REDACTED_<KIND>]`. `redact.Strict` also catches URL credentials, Bearer
  headers and secret query parameters, and writes `[redacted]`. Logs use Strict. Prompts use Secrets, because
  `code=` or `Bearer` in an issue is ordinary text.
- The gate tail still replaces a whole line with `[redacted]` when it holds a token (existing behaviour).
- Left alone: `browsercheck/secrets.go` and `eval/replay` (outside my area; replay already calls
  `sanitize.RedactSecrets`, so it gets the new list).
- `go test -race ./...` passes on every package.
- `just` is not installed here. I ran the gate steps by hand: gofmt, `go vet`, `./gate.sh lint` (0 issues),
  `go run ./tools/ratchet` (go_lines 42837, under baseline 42880), `go test -race ./...`.

## Upstreams copied

- gitleaks/gitleaks@5f6ec56 `cmd/generate/config/rules/*.go`: token families (MIT). Entry added to THIRD_PARTY_NOTICES.md.
- anthropics/claude-code-action@8a29bc6 `src/github/utils/sanitizer.ts`: AWS boundary rule, already in the repo; moved with the code.

## Files outside my area

`THIRD_PARTY_NOTICES.md` (notice entries, required by the provenance test).

## Workflow changes needed

None.
