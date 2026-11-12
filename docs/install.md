# Install

Two ways to get the `factory` CLI. Both install a prebuilt binary from a GitHub release.

## Script

```sh
curl -fsSL https://raw.githubusercontent.com/KaaS-team/KaaS-factory/main/install/install.sh | sh
```

The script detects your OS (macOS or Linux) and CPU (amd64 or arm64), downloads the archive and
`checksums.txt` from the latest release, checks the sha256, and copies `factory` to
`$HOME/.local/bin`. It never uses sudo. If the checksum does not match, it installs nothing.

| Variable | Effect |
|---|---|
| `FACTORY_VERSION` | Install a release tag such as `v9.0.0` instead of the latest. |
| `FACTORY_BIN_DIR` | Install somewhere other than `$HOME/.local/bin`. |

## Homebrew

```sh
brew install kaas-team/tap/factory
```

Homebrew installs the same release binary from the `KaaS-team/homebrew-tap` formula and handles
upgrades with `brew upgrade factory`.

## Next

```sh
factory doctor
```

## Releasing

`goreleaser` builds the four archives (`factory_<os>_<arch>.tar.gz`), the checksums file and the
tap formula from `.goreleaser.yaml`. The release workflow is added by the supervisor.
