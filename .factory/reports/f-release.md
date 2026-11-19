# f-release

## Demo commands
```
goreleaser release --snapshot --clean   # release succeeded after 7s
ls dist                                 # four factory_<os>_<arch>.tar.gz, checksums.txt, homebrew/Formula/factory.rb
cd dist && sha256sum -c checksums.txt   # all four: OK
go test ./packaging/...                 # ok installsh, ok homebrew
curl -fsSL https://raw.githubusercontent.com/KaaS-team/factory/main/install.sh | sh
brew install kaas-team/tap/factory
go install github.com/KaaS-team/factory/cmd/factory@latest
```
The curl, brew and go install lines work only after the rename and a first tagged release.

## Acceptance
- Snapshot builds darwin and linux, amd64 and arm64, CGO off: done.
- Go test runs install.sh against an httptest server, fails on a bad checksum: done (`packaging/installsh`, moved from `install/`).
- docs/install.md has brew, curl and go install lines: done.

## Upstreams copied
None. The installer and goreleaser config were already on `next`; I changed URLs and paths only.

## Files outside my area
- `README.md` line 27 still points at `install/install.sh` and the old repo name. Change it to
  `https://raw.githubusercontent.com/KaaS-team/factory/main/install.sh`.
- `install/` is gone: `install.sh` moved to the repo root, its test to `packaging/installsh/`.

## Workflow changes needed
- `.github/workflows/release.yml` already runs goreleaser on `v*` tags. It needs the `HOMEBREW_TAP_GITHUB_TOKEN`
  secret and `KaaS-team/homebrew-tap` must exist. No YAML change needed.
- goreleaser warns that `brews` is deprecated (use `homebrew_casks`/`nix`). Kept as the ticket asks.
