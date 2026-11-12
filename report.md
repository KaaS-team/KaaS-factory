BRANCH: go/k4-release
HEAD: a84816e34df42ae02c97b996e3d8dd1d768b68ee
## Summary
`.goreleaser.yaml` and `install/install.sh` already existed on `next` and met most of the ticket, so I added what was missing: `$PREFIX` support, a python3 http.server install test, and the brew formula template with a test that pins its archive names to goreleaser's.
## Acceptance
- goreleaser check passes (v2.12.0, darwin/linux, amd64/arm64, CGO_ENABLED=0, checksums) -> `go run github.com/goreleaser/goreleaser/v2@v2.12.0 check`: valid, one deprecation warning (`brews` is being phased out for `homebrew_casks`) -> done
- install.sh downloads, verifies checksum, installs to ~/.local/bin or $PREFIX/bin; shellcheck clean (shellcheck-py) -> TestPrefixInstallsUnderPrefixBin (failed first), TestInstallsFromPythonHTTPServer (passed on first run, since the script already worked), existing httptest tests -> done. The script stays at `install/install.sh` (not repo root) because docs and tests already point there.
- Brew formula template matches archive names -> TestFormulaTemplateMatchesGoreleaserArchives (seen red when a name was changed) -> done
- Workflow YAML in report -> below -> done
## Measures
- Non-test Go lines: 20357 before, 20357 after (only test files added).
- Deadcode: 68 lines after. I did not capture a "before" run; no non-test Go changed, so it is unchanged by construction.
## Workflow YAML for the supervisor
```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  goreleaser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod }
      - uses: goreleaser/goreleaser-action@v6
        with:
          distribution: goreleaser
          version: v2.12.0
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_GITHUB_TOKEN: ${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}
```
The `brews` block pushes to KaaS-team/homebrew-tap; a token with write access there is needed. goreleaser's `brews.repository.token` is not set in `.goreleaser.yaml`, so either the default GITHUB_TOKEN must reach the tap or the supervisor adds `token: "{{ .Env.HOMEBREW_TAP_GITHUB_TOKEN }}"` (I did not edit it).
## API change requests
none
## Files outside my area
- `install/install.sh`, `install/install_test.go`, `docs/install.md`: they already existed and the PREFIX change belongs there.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK.
## Learnings
- The brief said "new" files that already existed; check `git ls-files` first.
- `just` is missing in cloud sessions; install it in the environment.
- Race tests exceed the 120s foreground limit; run the gate in the background.
