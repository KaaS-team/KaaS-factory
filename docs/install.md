# Install

Three ways to get the `factory` CLI. Brew and the script install a prebuilt binary from a GitHub release.

## Script

```sh
curl -fsSL https://raw.githubusercontent.com/KaaS-team/factory/main/install.sh | sh
```

The script detects your OS (macOS or Linux) and CPU (amd64 or arm64), downloads the archive and
`checksums.txt` from the latest release, checks the sha256, and copies `factory` to
`$HOME/.local/bin`. It never uses sudo. If the checksum does not match, it installs nothing.

| Variable | Effect |
|---|---|
| `FACTORY_VERSION` | Install a release tag such as `v9.0.0` instead of the latest. |
| `FACTORY_BIN_DIR` | Install somewhere other than `$HOME/.local/bin`. |
| `PREFIX` | Install to `$PREFIX/bin` when `FACTORY_BIN_DIR` is unset. `PREFIX=/usr/local` needs a user who can write there. |

## Homebrew

```sh
brew install kaas-team/tap/factory
```

Homebrew installs the same release binary from the `KaaS-team/homebrew-tap` formula and handles
upgrades with `brew upgrade factory`.

## Go

```sh
go install github.com/KaaS-team/factory/cmd/factory@latest
```

This builds from source and needs Go 1.26 or newer. The binary lands in `$(go env GOPATH)/bin`.

## Next

```sh
factory doctor
```

## Releasing

`goreleaser` builds the four archives (`factory_<os>_<arch>.tar.gz`), the checksums file and the
tap formula from `.goreleaser.yaml`. The release workflow runs on a `v*` tag and needs the `HOMEBREW_TAP_GITHUB_TOKEN` secret.

The binary reports its build with `factory --version`: version, commit and date.

To try it without publishing: `goreleaser release --snapshot --clean`, then look in `dist/`.
