# KaaS Factory

KaaS Factory turns a goal into reviewed pull requests. It plans tickets, runs them on parallel
coding-agent sessions, checks each result against your gates, and lands them through a merge queue.

## Quickstart

```sh
factory doctor
factory first-run
factory board --replay docs/demo/fleet.ndjson
```

`doctor` checks your tools. `first-run` audits the repository and lists the first fixes. `board --replay`
shows a fleet from a recorded run, with nothing to set up.

## Install

```sh
brew install kaas-team/tap/factory
```

Or with no sudo, checksum first:

```sh
curl -fsSL https://raw.githubusercontent.com/KaaS-team/KaaS-factory/main/install.sh | sh
```

More in [docs/install.md](docs/install.md).

## Use it

```sh
factory plan "add rate limiting to the API" --approve
factory run
factory status
```

Also `queue`, `logs`, `steer`, `cancel` and `retry`. Full list: [docs/cli-reference.md](docs/cli-reference.md).

## MCP

`factory mcp` serves over stdio, or `--http 127.0.0.1:8080` with a bearer secret. Demo:
[docs/demo/mcp.md](docs/demo/mcp.md).

## Configuration

Layers, lowest to highest: defaults, org file, team file, repository file, `FACTORY_*` variables,
flags. Pick a preset with `factory init --tier <name>`. Every key is in [docs/config.md](docs/config.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Licence: [LICENSE](LICENSE). Run `just check` before you push.
