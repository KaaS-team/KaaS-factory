#!/usr/bin/env bash
# The push gate every kit repo runs: its .githooks/pre-push is a stub sync-vendored.py writes, so no repo's
# hook can drift. git's ref lines arrive on stdin. Why: docs/decisions/scripts.md#pre-pushsh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
# git hands a hook in a linked worktree GIT_DIR, and a gate's tests that make their own repos then hit this one.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX

# A push that only deletes refs sends no commit, so there is nothing to gate: deleting a merged
# branch ran the whole gate on the lwpr box (22 Oct 2026). A delete has an all-zero local sha.
# stdin is put back after, because push-remote.sh reads the same lines.
REFS=$(cat)
if [ -n "$REFS" ] && ! printf '%s\n' "$REFS" | awk '$2 !~ /^0+$/ {sends = 1} END {exit !sends}'; then
  echo "pre-push: only deleting refs, nothing to gate." >&2
  exit 0
fi
exec <<EOF
$REFS
EOF

if [ "${SKIP_GATE:-}" = "1" ]; then
  echo "pre-push: SKIP_GATE=1, gate NOT run. You are pushing unverified work." >&2
  exit 0
fi

# The audit takes a second and catches a stale install before any minutes are spent.
python3 scripts/lwp/check-affected.py --audit || exit 1
GATE="python3 scripts/lwp/check-affected.py --run --stage stop"
# prePush runs here after the gate, queued or passed: it needs what the box lacks (secrets, a docker engine).
HERE=$(python3 scripts/lwp/check-repo.py --key prePush) || exit 1

# With a .lwpr.toml the gate runs on the build box and the push goes now; if the box cannot take the job,
# it runs here. LWPR_LOCAL=1 forces here.
if [ -f .lwpr.toml ] && [ "${LWPR_LOCAL:-}" != "1" ] && command -v lwpr >/dev/null \
  && scripts/lwp/push-remote.sh "$GATE"; then
  echo "pre-push: gate queued on the build box."
else
  echo "pre-push: running \`$GATE\`. SKIP_GATE=1 to bypass."
  if ! eval "$GATE"; then
    echo "pre-push: the gate failed. Fix it, or push with SKIP_GATE=1 and say why." >&2
    exit 1
  fi
  echo "pre-push: gate passed."
fi
if [ -n "$HERE" ] && ! eval "$HERE"; then
  echo "pre-push: \`$HERE\` (repo.json prePush) failed." >&2
  exit 1
fi
