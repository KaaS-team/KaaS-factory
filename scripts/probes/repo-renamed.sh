#!/bin/bash
# The repo moved to KaaS-team/KaaS-factory in v5.1.0; GitHub redirects the old name, so only the
# API's canonical name and this checkout's remote prove the rename happened.
set -euo pipefail
name="$(gh api repos/KaaS-team/KaaS-factory --jq .full_name)"
[ "$name" = "KaaS-team/KaaS-factory" ] || { echo "GitHub calls it $name" >&2; exit 1; }
git remote get-url origin | grep -q "KaaS-team/KaaS-factory" || { echo "origin still points at the old name" >&2; exit 1; }
