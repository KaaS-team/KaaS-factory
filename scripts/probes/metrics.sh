#!/bin/bash
# The last 20 finished runs against the factory's three bars (scripts/metrics.ts BARS). The export goes into
# a scratch dir; with fewer than 20 finished runs the check passes and says how many there are.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
"$root/bin/factory" learn --export "$scratch/export.jsonl"
bun "$root/scripts/metrics.ts" "$scratch/export.jsonl" --check
