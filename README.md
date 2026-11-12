# KaaS Factory

KaaS Factory turns the issues in your repository into reviewed pull requests. You describe work as
tickets. The factory plans each one, hands it to a coding agent in its own session, checks the result
against your gates, and lands it through a merge queue. You stay in control: risky changes wait for
your approval, and every limit is a setting you own.

## What it does for a codebase

- Reads the repository and scores how ready it is for agents, then proposes the first fixes.
- Splits a goal into tickets and runs several of them at the same time.
- Runs your own gates (tests, lint, build) before anything is proposed for merge.
- Keeps a merge queue so parallel work lands one change at a time on a green base.
- Records what each session did, so a person can review it later.

## Install

With Homebrew:

```sh
brew install kaas-team/tap/factory
```

With the install script (no sudo, installs to `$HOME/.local/bin`, checks the checksum first):

```sh
curl -fsSL https://raw.githubusercontent.com/KaaS-team/KaaS-factory/main/install/install.sh | sh
```

Check it worked:

```sh
factory version
```

More detail is in [docs/install.md](docs/install.md).

## Start

Inside the repository you want to automate:

```sh
factory init
```

This writes `.factory/factory.yaml` with the settings for the repository. Every key is listed in
[docs/config.md](docs/config.md).

Then run a first audit:

```sh
factory first-run
```

It scores the repository, shows the first fixes it would make, and changes nothing until you approve.
Add `--dry-run` to preview only.

Then start the loop:

```sh
factory run
```

Use `factory status` to see what is running, `factory queue` to see what waits to merge, and
`factory doctor` to check your setup. The full command list is in the CLI reference.

## Configuration

Settings come from layers, lowest to highest: builtin defaults, the org file, the team file, the
repository file, `FACTORY_*` environment variables, and flags. The org layer is a ceiling: lower
layers may lower a limit but never raise it.

## Documents

- [docs/config.md](docs/config.md): every config key, generated from the code.
- [docs/install.md](docs/install.md): install and upgrade.
- [docs/self-host.md](docs/self-host.md): running the factory yourself.
- [CONTRIBUTING.md](CONTRIBUTING.md): working on the factory itself.

## License

See [LICENSE](LICENSE).
