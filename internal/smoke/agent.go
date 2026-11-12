package smoke

// agentScript is the fake agent: no model, it does what a build session does at the end of a run.
// It writes the one file the ticket asks for, commits on the ticket branch, pushes it, pushes a
// report commit to report/<ticket> (the technique the brief gives), and opens the pull request.
// The token reaches curl on stdin, never on its command line.
const agentScript = `#!/bin/sh
# Fake agent for the factory smoke test. Needs SMOKE_FILE, SMOKE_API_URL, SMOKE_REPO, SMOKE_BASE,
# SMOKE_TOKEN and optionally SMOKE_LOG in its environment. Runs inside the ticket's worktree.
set -eu
[ -z "${SMOKE_LOG:-}" ] || exec 2>>"$SMOKE_LOG"
branch=$(git rev-parse --abbrev-ref HEAD)
ticket=${branch#factory/}
ticket=${ticket%-a*}
mkdir -p "$(dirname "$SMOKE_FILE")"
printf 'smoke test file for ticket %s\n' "$ticket" > "$SMOKE_FILE"
git add -- "$SMOKE_FILE"
git -c user.name=smoke-agent -c user.email=smoke-agent@localhost -c commit.gpgsign=false commit -q -m "smoke: add $SMOKE_FILE"
git push -q origin "HEAD:refs/heads/$branch"
blob=$(printf 'Smoke run for ticket %s: added %s.\n' "$ticket" "$SMOKE_FILE" | git hash-object -w --stdin)
tree=$(printf '100644 blob %s\treport.md\n' "$blob" | git mktree)
commit=$(git -c user.name=smoke-agent -c user.email=smoke-agent@localhost -c commit.gpgsign=false commit-tree "$tree" -m report)
git push -q origin "$commit:refs/heads/report/$ticket"
json=$(printf '{"title":"smoke: add %s","head":"%s","base":"%s","body":"Smoke test for ticket %s."}' "$SMOKE_FILE" "$branch" "$SMOKE_BASE" "$ticket")
printf 'header = "Authorization: Bearer %s"\n' "$SMOKE_TOKEN" |
  curl -fsS -K - -X POST -H 'Accept: application/vnd.github+json' -d "$json" "$SMOKE_API_URL/repos/$SMOKE_REPO/pulls" >/dev/null
`
