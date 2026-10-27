#!/usr/bin/env bash
# Runs once per container start, before any `factory` subcommand. `gh auth
# setup-git` wires gh's own credential helper into git so pushes authenticate
# without ever putting GH_TOKEN in a remote URL or a file on disk — the same
# residual-risk shape the executor's env scrub already assumes for `claude`
# (audit finding #14; see README's security residuals section).
set -euo pipefail

if [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  gh auth setup-git
else
  echo "factory: no GH_TOKEN/GITHUB_TOKEN set — gh operations will fail until one is provided" >&2
fi

if [[ -f ./ee/register.ts && "${FACTORY_EE:-}" != "0" ]]; then
  exec bun --preload ./ee/register.ts bin/factory "$@"
fi
exec bun bin/factory "$@"
