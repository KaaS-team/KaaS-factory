# Security

The factory is not a sandbox. It runs an agent that executes commands, and the only boundary is the
runtime you choose.

## What each runtime isolates

- `local` runs on this machine with no isolation and open egress.
- `docker` is a container with egress denied unless the runtime names a network.
- `microsandbox` is a microVM with egress denied except its `allow` list.
- `ssh`, `lwpr`, `http`, `agent37` and `codespaces` run on a remote host. The host decides isolation.
- `wrap` and `pool` report isolation as unknown.

## What it does not isolate

The agent inherits your environment, including model provider keys and `~/.config/gh`. Only
`GH_TOKEN`, `GITHUB_TOKEN`, `FACTORY_*` and the repository-pointing git variables are removed.
Use a spend-capped key and a runtime from the list above.

## Reporting

Report a vulnerability privately to the maintainer in `.github/CODEOWNERS`, not in a public issue.
