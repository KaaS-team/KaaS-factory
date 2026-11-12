BRANCH: go/k6-astgrep-pack
HEAD: 4ca3a2cc88e39c90a5a2907eef80a90874a3553a
## Summary
New package `internal/packs/astgrep` (374 non-test lines): pinned ast-grep 0.51.2 archive checksums, a jail runner (no network), a `scan --json` decoder, a typed rule-load error, a rule-directory check pack loader, an `ast-grep test` scorecard and a severity-to-gate mapping, with a 3-rule example pack. It is not yet reachable from `cmd/factory` (see API change requests), and the real binary was never run here.
## Acceptance
- #1 lock records version and sha256 -> TestPinsRecordVersionAndSHA256, TestVerifyArchive -> done for the pins and the check; blocked for writing them into factory.lock (lock.go is outside my area)
- #1 `scan --json` parsed to our finding type -> TestParseFindings -> done
- #1 runs with no network -> TestJailDeniesNetworkAndScopesWrites (spec denies net; report says "network: denied"); no test runs the real binary under the jail -> done at spec level only
- #1 failing rule load returns a typed error -> TestScanExitCodes, TestEvalErrors (*RuleLoadError) -> done
- #3 scorecard shows rules passed/total -> TestEvalScorecard ("rules passed 1/3") -> done
- #3 severity maps to the policy gate -> TestSeverityPolicy, TestGateBlocksOnErrorFindings -> done
- #3 one example pack with 3 rules -> TestLoadPackExample -> done, but with no `__snapshots__`: I could not generate them without running the binary, so invalid cases are untested against the real binary
- Bite-checks (reverted each once, test went red): AllowNet, line offset, exit>1, error->block, sha compare, PASS counting, KnownFields, eval load error. The exit>1 mutation first survived; I added the row "exit 2 wins over parsable output" and it now dies.
## API change requests
- Wire the package into `cmd/factory` (e.g. a `packs check <dir>` command calling LoadPack, Eval, Scan, Gate) and add a fetch step that downloads the archive for `Pins[goos/goarch]`, calls `Pin.Verify`, and unzips. Without this, deadcode rises 68 -> 81 (+13 unreachable symbols).
- Add a tool kind or field to `internal/packs/lock.go` so factory.lock records `{tool: ast-grep, version, sha256}`; `astgrep.Pin` has the JSON shape.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: new `ast-grep/ast-grep@c7e005c` section, required by the provenance test.
## Left out
- Ticket #2 (transform workflow): out of scope per brief.
- Vendoring `schemas/*.json` plus a JSON-schema library: needs a new dependency not named for tickets #1/#3 and adds large files against the line budget. `LoadPack` checks id, language, rule, severity and rejects unknown keys instead.
- Snapshot fixture format reimplementation: delegated to `ast-grep test`, parsed by its PASS/FAIL/SKIP lines.
## Measures
- Non-test Go lines (tracked, excluding src/): 20357 before, 20731 after (+374 untracked files counted here). Over the 8000-line budget either way; nothing could be deleted inside my area.
- Deadcode: 68 before, 81 after.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7:
gofmt -l: clean; go vet ./...: clean; golangci-lint v2.13.2 run ./...: `0 issues.`; go test -race ./...: all ok; CGO_ENABLED=0 go build ./cmd/factory: built.
## Learnings
- The auto-mode classifier denied unzipping and running a downloaded release binary, so nothing that needs the real ast-grep could be verified here; the factory should provide a pre-approved pinned binary in cloud sessions.
- The brief gave no ast-grep version for the pinned SHA; I read it from Cargo.toml (0.51.2).
- `just` is missing in the cloud image.
