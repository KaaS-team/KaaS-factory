BRANCH: go/release
HEAD: b5804b60bfeaed03be28fa15183ad72f097d56b9
## Summary
Added `.goreleaser.yaml`, `install/install.sh` with a Go test package, and `docs/install.md` (38 lines). The installer verifies sha256 before installing anything. `goreleaser check` is blocked and shellcheck is not installed.
## Acceptance
- goreleaser check passes -> none -> blocked (goreleaser is not installed, and the sandbox denied `go run github.com/goreleaser/goreleaser/v2@latest check`; I did not work around the denial. Config is written to the v2 schema but unvalidated)
- install.sh installs a fake binary from the local server and it runs -> TestInstallsFakeBinaryAndItRuns (also TestPinnedVersionUsesTaggedRelease, TestPlatformDetection, TestMissingArchiveFailsCleanly) -> done
- Tampered archive fails the checksum and installs nothing -> TestTamperedArchiveFailsChecksumAndInstallsNothing -> done
- shellcheck clean -> none -> blocked (shellcheck not available; only `sh -n` syntax check run)
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt, go vet ./..., go test -race ./... (all ok), CGO_ENABLED=0 go build ./cmd/factory (ok), golangci-lint v2.13.2 on go1.26.7: "0 issues."
## Learnings
- `just`, goreleaser and shellcheck are not in the cloud image; preinstall them so these checks can run.
- The sandbox classifier denies `go run <tool>@latest`, so a brief that names that fallback cannot use it; pin and preinstall the tool instead.
- Release URL base and uname overrides (FACTORY_BASE_URL, FACTORY_UNAME_S/M) are my choices for testability; the supervisor's release workflow must publish assets at /releases/download/<tag>/ with checksums.txt.
