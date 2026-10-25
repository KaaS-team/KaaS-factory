#!/usr/bin/env bash
# pre-push in a repo with a .lwpr.toml: queue GATE for each pushed commit on the lwpr box, exit 0.
# Non-zero means the caller runs the gate locally. Usage: push-remote.sh GATE < pre-push ref lines
# Why: docs/decisions/scripts.md#push-remotesh
set -uo pipefail

gate=$1
sent=0
while read -r _lref lsha _rref rsha; do
  # A deleted branch pushes the zero sha; there is nothing to check.
  [ -n "${lsha//0/}" ] || continue
  # The box gets a tree with no history, so check-affected there would run the full gate; name the pushed
  # files instead. A new branch diffs from where it left the default branch.
  run=$gate
  case $gate in "python3 scripts/lwp/check-affected.py"*)
    base=$rsha
    [ -n "${base//0/}" ] && git cat-file -e "$base" 2>/dev/null \
      || base=$(git merge-base "$lsha" "$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)" 2>/dev/null)
    files=$([ -n "$base" ] && git diff --name-only "$base" "$lsha" | paste -sd, -)
    [ -n "$files" ] && run="$gate --files $(printf '%q' "$files")"
    ;;
  esac
  out=$(lwpr run -d --trigger push --commit "$lsha" -- "$run" 2>&1) || {
    printf '%s\n' "$out" >&2
    exit 1
  }
  id=$(printf '%s\n' "$out" | grep -oE 'job [0-9]+' | head -n 1 | cut -d' ' -f2)
  [ -n "$id" ] || exit 1
  echo "pre-push: \`$gate\` for ${lsha:0:12} is job $id on the build box. Pushing now; lwpr logs $id -f" >&2
  name=$(basename "$(pwd)")
  (
    if ! lwpr wait "$id" >/dev/null 2>&1 && command -v osascript >/dev/null; then
      osascript -e "display notification \"job $id: $gate failed on the build box\" with title \"lwpr: $name push\" sound name \"Basso\""
    fi
  ) </dev/null >/dev/null 2>&1 &
  disown
  sent=1
done
[ "$sent" = 1 ]
