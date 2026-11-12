TICKET: m1-fix
NEXT: 9f7be7628306a8922e98cad7b3e3a4b0c564f6df
## Merged
- none
## Skipped
- go/k4-sandbox-harden-fix -> push rejected as non-fast-forward 7 times (6 retries used up). The merge passed the full gate every time (last local merge cca2382 on e36218c), and `go test -race -count=20 ./internal/dispatch/local` passed. Another session landed on next about once a minute (21:32 to 21:41 UTC), faster than one gate run, so every push lost the race.
- go/k5-eval-arms-fix, go/fix-egress-ssrf -> not attempted: the brief orders them after k4-sandbox-harden-fix. Both merge cleanly on top of it (checked locally).
- go/k5-local-auth, go/k5-preset-rules, go/k5-sandbox-runsc -> not attempted: they depend on the three fix branches above.
- go/k5-sandbox-lifecycle -> not attempted. It merges cleanly on next+k4, and `go vet ./pkg/sandbox` passes there: the `undefined: run` error did not reproduce without go/k5-sandbox-limits.
- go/k5-sandbox-limits -> not attempted. It conflicts in internal/dispatch/local/local.go: next keeps the stuck guard and uses `killGroup(cmd)` plus `p.err = stuckErr`, while the branch uses `sandbox.KillGroup(cmd)`. Fix: keep the stuckErr block and call `sandbox.KillGroup`. On top of lifecycle it also conflicts in pkg/sandbox/{plan,sandbox,unix}.go.
- go/k6-approval -> not attempted. Cause of the gate failure: `internal/tracker/github/approval.go:12: undefined: Latest, ParseData`. The marker codec moved to `internal/marker` (k4-marker-codec merge), so the fix is to import it and call `marker.Latest(marker.ParseData(c.Body), stagePlan)`.
## Review notes
- go/k4-sandbox-harden-fix: `sessionConfigDir` copies the operator's .credentials.json into a new /tmp dir for each session and never removes it, including on the error path, so login copies pile up in the temp dir. The temp dir is also writable from every jail. Under GitDir the jail can write all of refs/, so an agent can move any branch ref, not just its own. Hooks and config are correctly kept out of reach.
## Gate evidence
(`just` is not installed, so I ran the `check` recipe body by hand. /usr/local/bin/golangci-lint is v2.5.0 built with go1.25 and cannot load a go1.26 module, so lint ran through the pinned `go run ...golangci-lint@v2.13.2` fallback.)
== fmt
== vet
== lint
0 issues.
== test
== build
== ratchet
go_lines 27861 (baseline 27861), deadcode 194 (baseline 194)
GATE OK
## Learnings
- next moved every ~60s from another merge session; a 1.5-2 min gate cannot win the push race. Serialize merge sessions or give this run a lock on next.
- The golangci-lint on PATH in the cloud image is v2.5.0, but the justfile prefers it over the pinned version, so `just check` lint fails there.
- `just` is missing from the cloud image.
