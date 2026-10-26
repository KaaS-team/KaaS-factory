#!/bin/bash
# factory.kaas.team runs this repo's image on Coolify: /health must answer as kaas-factory at the
# version in package.json, so a stale deploy or another app on the domain fails the probe.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
want="$(jq -r .version "$root/package.json")"
body="$(curl -fsS --max-time 15 https://factory.kaas.team/health)"
[ "$(jq -r .service <<<"$body")" = "kaas-factory" ] || { echo "factory.kaas.team/health is not the factory: $body" >&2; exit 1; }
[ "$(jq -r .version <<<"$body")" = "$want" ] || { echo "factory.kaas.team runs $(jq -r .version <<<"$body"), this checkout is $want" >&2; exit 1; }
# Anonymous callers must be refused everything but /health.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://factory.kaas.team/api/runs)"
case "$code" in 401|403|503) ;; *) echo "factory.kaas.team/api/runs answered $code to an anonymous caller" >&2; exit 1 ;; esac
